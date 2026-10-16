"""Download / inspect / remove the on-device ML models.

Two models are managed:

* **Whisper** (voice input) — a faster-whisper / CTranslate2 snapshot in
  ``models/whisper/`` (default repo ``Systran/faster-whisper-medium``).
* **Embedding** (RAG memory / web recall) — an e5-style ONNX model in an
  HF-cache-style folder ``models/models--<org>--<name>/`` (default
  ``intfloat/multilingual-e5-base``). Every downloaded repo keeps its own
  folder, so several builds can coexist and be removed independently.

Downloads use ``huggingface_hub.snapshot_download`` (the same mechanism as
``download-whisper.py``) and support arbitrary HF mirror endpoints via the
``base_url`` field. Work runs on a background thread and state is tracked
in-memory so the Settings UI can poll ``/models/status``.

This file never auto-downloads — models are fetched only when the user asks.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sys
import threading
import time
from collections import deque

logger = logging.getLogger("models")

_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = _MODULE_DIR

KIND_WHISPER = "whisper"
KIND_EMBEDDING = "embedding"
KIND_DECISION = "decision"

# Download tuning for slow / filtered networks (applied in start_download):
# fewer parallel file workers = steadier per-file speed and less connection
# thrashing; longer metadata timeout = slow HEAD requests no longer fail
# after 10s and trigger a full retry-backoff stall.
_SNAPSHOT_MAX_WORKERS = 4
_SNAPSHOT_ETAG_TIMEOUT = 30

# Prefer the Rust-backed high-performance transfer backends when available
# (much higher single-file throughput than the pure-Python fallback).
# Opt in here so users get it without setting env vars manually; harmless
# when the optional packages are absent.
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")

WHISPER_DEFAULT_REPO = "Systran/faster-whisper-medium"
EMBEDDING_DEFAULT_REPO = "intfloat/multilingual-e5-base"
DECISION_DEFAULT_REPO = "convaiinnovations/laya"
# Subfolder of the models root holding huggingface_hub's own cache layout.
_HUB_CACHE_DIRNAME = "hub-cache"


_MIGRATE_LOCK = threading.Lock()
_migrated = False


def _raw_models_root() -> str:
    """The data-root ``models/`` path, with no migration side effect."""
    try:
        from state_db import data_root

        root = data_root()
    except Exception:  # noqa: BLE001 — standalone fallback
        root = os.path.join(os.path.expanduser("~"), ".codifa")
    return os.path.join(root, "models")


def _models_dir() -> str:
    """Model storage under the user data root.

    Every caller (embeddings.model_dir, whisper_dir, whisper_ready,
    embedding_dirs, status) goes through this function, so the legacy
    ``backend/whisper`` / ``backend/models--*`` migration runs once per
    process, regardless of who calls first.
    """
    global _migrated
    target = _raw_models_root()
    if not _migrated:
        with _MIGRATE_LOCK:
            if not _migrated:
                _migrate_legacy_models(target)
                _migrate_decision_dir_name(target)
                _migrated = True
    return target


def hub_cache_dir() -> str:
    """Dedicated huggingface_hub cache dir."""
    return os.path.join(_models_dir(), _HUB_CACHE_DIRNAME)


def _user_whisper_model() -> str:
    """Whisper model the user selected in Settings (fallback to default)."""
    try:
        from state_db import get_settings

        settings = get_settings()
        if isinstance(settings, dict):
            model = str(settings.get("whisperModel") or "").strip()
            if model:
                return model
    except Exception:  # noqa: BLE001, S110 — standalone fallback
        pass
    return WHISPER_DEFAULT_REPO


def whisper_dir() -> str:
    model = _user_whisper_model()
    if model == WHISPER_DEFAULT_REPO:
        return os.path.join(_models_dir(), "whisper")
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(model).replace("/", "--")).strip("-")
    return os.path.join(_models_dir(), f"whisper--{slug}") if slug else os.path.join(_models_dir(), "whisper")


def _embedding_dir(repo: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(repo).replace("/", "--")).strip("-")
    return os.path.join(_models_dir(), f"models--{slug}") if slug else ""


def _decision_dirname(repo: str) -> str:
    """Decision-model folder name: the official release layout
    ``<model>--<org>--<name>`` (e.g. ``laya--convaiinnovations--laya``),
    so a manually downloaded copy is found without any rename."""
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(repo).replace("/", "--")).strip("-")
    model = str(repo).strip().split("/")[-1]
    return f"{model}--{slug}" if slug else ""


def _decision_dir(repo: str) -> str:
    """Absolute path of the decision-model folder ('' for a blank repo)."""
    name = _decision_dirname(repo)
    return os.path.join(_models_dir(), name) if name else ""


def _migrate_legacy_models(target_root: str | None = None) -> None:
    """Move models previously stored under ``backend/whisper`` /
    ``backend/models--*`` into the data-root ``models/`` folder so an app that
    already downloaded them keeps working after the path change.

    ``target_root`` is passed by ``_models_dir()`` to avoid recursing back
    into itself; ``status()`` calls this with no argument, which is fine
    since it only re-checks already-migrated dirs (cheap, idempotent).
    """
    target_root = target_root or _raw_models_root()
    legacy_dirs = [
        os.path.join(BACKEND_DIR, "whisper"),
        *[
            os.path.join(BACKEND_DIR, name)
            for name in os.listdir(BACKEND_DIR)
            if name.startswith("models--")
        ],
    ]
    for src in legacy_dirs:
        if not os.path.isdir(src):
            continue
        dest = os.path.join(target_root, os.path.basename(src))
        if os.path.isdir(dest):
            continue
        try:
            os.makedirs(target_root, exist_ok=True)
            shutil.move(src, dest)
        except Exception:  # noqa: BLE001, S112 — migration must never crash startup
            continue


def _migrate_decision_dir_name(root: str | None = None) -> None:
    """Rename a pre-fix ``models--<repo>`` decision download to the release
    layout ``<model>--<org>--<name>`` so it keeps being found. Skipped when the
    release-layout folder already exists (never touches user data).

    Computes the old name inline: calling ``_embedding_dir`` here would
    re-enter ``_models_dir`` mid-migration (the ``_migrated`` flag is still
    unset at that point) and recurse forever.
    """
    root = root or _raw_models_root()
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", DECISION_DEFAULT_REPO.replace("/", "--")).strip("-")
    old = os.path.join(root, f"models--{slug}")
    new = os.path.join(root, _decision_dirname(DECISION_DEFAULT_REPO))
    if not os.path.isdir(old) or os.path.isdir(new):
        return
    try:
        os.rename(old, new)
    except OSError:  # migration must never crash startup
        pass


# --- live download state (one entry per kind) --------------------------- #
# {"state": "downloading"|"paused"|"error", "repo": str, "error": str,
#  "base_url": str, "downloaded_bytes": int, "total_bytes": int,
#  "percent": float, "speed_bps": float, "updated_at": float}
_STATES: dict[str, dict] = {}
_LOCK = threading.RLock()
# Tripwire for external deletion of model dirs (e.g. a system cleaner wiping
# the data-root models folder). status() records ready dirs in the persistent
# witness file models-watch.json (sibling of models/, never inside it); a dir
# that was ready before but is gone now WITHOUT going through remove() gets
# one WARNING in codifa.log with its last-seen timestamp. Codifa itself never
# deletes model dirs except via remove(), so a warning here points outside
# the app. _REMOVED_BY_APP suppresses the warning for explicit user deletes.
_REMOVED_BY_APP: set[str] = set()
# کنترل مکث/توقف هر دانلود: pause ست یعنی مکث، cancel ست یعنی توقف.
_CONTROLS: dict[str, dict[str, threading.Event]] = {}
# نمونه‌های سرعت (زمان، بایت تجمعی) برای هر kind — میانگین ۵ ثانیه اخیر.
_SPEED_SAMPLES: dict[str, deque] = {}


class _DownloadCancelled(Exception):
    """خطای داخلی توقف دانلود توسط کاربر (به UI به‌عنوان خطا نشان داده نمی‌شود)."""


def _controls_for(kind: str) -> dict[str, threading.Event]:
    with _LOCK:
        entry = _CONTROLS.get(kind)
        if entry is None:
            entry = {"pause": threading.Event(), "cancel": threading.Event()}
            _CONTROLS[kind] = entry
        return entry


# --- cancellable sleep for HF retry backoff ------------------------------ #
# ``huggingface_hub`` retries failed HEAD/GET inside ``time.sleep`` (up to
# 5 tries with exponential backoff). While sleeping, our tqdm ``update``
# hook never runs, so pause/cancel looked dead. Patch ``time.sleep`` once:
# download threads sleep in 0.1s slices and raise ``_DownloadCancelled``
# as soon as their kind's cancel flag is set.
_ORIG_SLEEP = time.sleep


def _cancellable_sleep(seconds: float) -> None:
    try:
        name = threading.current_thread().name
    except Exception:  # noqa: BLE001 — never break sleep
        _ORIG_SLEEP(seconds)
        return
    kind = name[len("model-dl-") :] if name.startswith("model-dl-") else ""
    if not kind:
        _ORIG_SLEEP(seconds)
        return
    try:
        controls = _CONTROLS.get(kind)
    except Exception:  # noqa: BLE001 — never break sleep
        controls = None
    if controls is None:
        _ORIG_SLEEP(seconds)
        return
    try:
        remaining = float(seconds or 0)
    except (TypeError, ValueError):
        return
    while remaining > 0:
        if controls["cancel"].is_set():
            raise _DownloadCancelled()
        step = min(remaining, 0.1)
        _ORIG_SLEEP(step)
        remaining -= step


# Patched once at import so every download thread inherits it.
time.sleep = _cancellable_sleep  # type: ignore[method-assign]


def _abort_hf_session() -> None:
    """Best-effort abort of in-flight HF HTTP requests on cancel."""
    try:
        from huggingface_hub.utils._http import close_session

        close_session()
    except Exception:  # noqa: BLE001, S110 — abort is best-effort only
        pass


def _record_bytes(kind: str, n: float, total_hint: float = 0) -> None:
    """ثبت بایت دانلودشده و به‌روزرسانی درصد و سرعت (نخ‌امن).

    افزایش منفی (پس‌گرد شمارنده وقتی سرور Range را نادیده می‌گیرد) هم
    پذیرفته می‌شود تا شمارنده‌ها با نوار پروگرس همگام بمانند.
    """
    try:
        inc = float(n or 0)
    except (TypeError, ValueError):
        return
    now = time.monotonic()
    with _LOCK:
        st = _STATES.get(kind)
        if st is None:
            return
        downloaded = float(st.get("downloaded_bytes") or 0) + inc
        total = float(st.get("total_bytes") or 0)
        try:
            hint = float(total_hint or 0)
        except (TypeError, ValueError):
            hint = 0
        total = max(total, hint)
        downloaded = max(downloaded, 0)
        st["downloaded_bytes"] = int(downloaded)
        st["total_bytes"] = int(total)
        st["percent"] = round(downloaded / total * 100, 1) if total > 0 else 0.0
        samples = _SPEED_SAMPLES.get(kind)
        if samples is None:
            samples = deque(maxlen=120)
            _SPEED_SAMPLES[kind] = samples
        samples.append((now, downloaded))
        cutoff = now - 5.0
        while len(samples) >= 2 and samples[0][0] < cutoff:
            samples.popleft()
        if len(samples) >= 2:
            dt = samples[-1][0] - samples[0][0]
            db = samples[-1][1] - samples[0][1]
            speed = db / dt if dt > 0.05 else 0.0
            st["speed_bps"] = speed if speed > 0 else 0.0
        else:
            st["speed_bps"] = 0.0
        st["updated_at"] = now


def _sync_total(kind: str, total: float) -> None:
    """همگام‌سازی حجم کل وقتی نوار پروگرس total را بزرگ می‌کند."""
    try:
        total = float(total or 0)
    except (TypeError, ValueError):
        return
    if total <= 0:
        return
    with _LOCK:
        st = _STATES.get(kind)
        if st is None:
            return
        if total > float(st.get("total_bytes") or 0):
            st["total_bytes"] = int(total)
            downloaded = float(st.get("downloaded_bytes") or 0)
            st["percent"] = round(downloaded / total * 100, 1) if total > 0 else 0.0


def download_state(kind: str) -> dict | None:
    with _LOCK:
        return dict(_STATES[kind]) if kind in _STATES else None


def _set_downloading(
    kind: str, repo: str, base_url: str = "", initial_bytes: int = 0
) -> None:
    """شروع حالت دانلود؛ پروگرس قبلی همان ریپو حفظ می‌شود (ادامه از نیمه)."""
    with _LOCK:
        prev = _STATES.get(kind)
        if prev and prev.get("repo") == repo and prev.get("state") in (
            "downloading",
            "paused",
            "error",
        ):
            prev["state"] = "downloading"
            prev["error"] = ""
            prev["base_url"] = base_url
            prev["updated_at"] = time.monotonic()
            return
        _STATES[kind] = {
            "state": "downloading",
            "repo": repo,
            "error": "",
            "base_url": base_url,
            "downloaded_bytes": max(int(initial_bytes or 0), 0),
            "total_bytes": int(prev.get("total_bytes") or 0)
            if prev and prev.get("repo") == repo
            else 0,
            "percent": 0.0,
            "speed_bps": 0.0,
            "updated_at": time.monotonic(),
        }
        if not (prev and prev.get("repo") == repo):
            _SPEED_SAMPLES.pop(kind, None)


def _set_error(kind: str, repo: str, error: str) -> None:
    with _LOCK:
        prev = _STATES.get(kind, {})
        _STATES[kind] = {
            "state": "error",
            "repo": repo,
            "error": error,
            "base_url": prev.get("base_url", ""),
            "downloaded_bytes": int(prev.get("downloaded_bytes") or 0),
            "total_bytes": int(prev.get("total_bytes") or 0),
            "percent": float(prev.get("percent") or 0.0),
            "speed_bps": 0.0,
            "updated_at": time.monotonic(),
        }


def _set_paused(kind: str) -> bool:
    with _LOCK:
        st = _STATES.get(kind)
        if not st or st.get("state") != "downloading":
            return False
        st["state"] = "paused"
        st["speed_bps"] = 0.0
        st["updated_at"] = time.monotonic()
        return True


def _set_resumed(kind: str) -> bool:
    with _LOCK:
        st = _STATES.get(kind)
        if not st or st.get("state") != "paused":
            return False
        st["state"] = "downloading"
        st["updated_at"] = time.monotonic()
        return True


def _clear_state(kind: str) -> None:
    with _LOCK:
        _STATES.pop(kind, None)
        _SPEED_SAMPLES.pop(kind, None)


# نسل اجرای هر kind — نخ قدیمی بعد از لغو/شروع جدید حق دست‌کاری وضعیت را ندارد.
_RUNS: dict[str, int] = {}

# Fast Rust-backed transfers when the optional ``hf_transfer`` package is
# installed (much higher single-file throughput than the pure-Python
# fallback). Opt in here so users get it without setting env vars manually;
# harmless when the package is absent.
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")

# Tuned ``snapshot_download`` settings for slow / filtered networks:
# fewer parallel file workers (less connection thrashing and steadier
# per-file speed) and a longer metadata timeout (slow HEAD requests used
# to fail after 10s and trigger a full retry-backoff stall).
_SNAPSHOT_MAX_WORKERS = 4
_SNAPSHOT_ETAG_TIMEOUT = 30

#: Files a decision-model (Laya) download does not need. The snapshot ships
#: three sub-builds (base, multilingual, typed-decisions) plus eval plots and
#: README assets; the router only ever loads the base and multilingual ONNX
#: graphs, so the rest is ~1 GB of dead weight on the user's disk.
_DECISION_IGNORE = ["typed-decisions/*", "eval/*", "assets/*"]

#: Budget for the one-time ONNX export that follows a Laya download. The export
#: builds a 28-layer encoder twice (base + multilingual) and quantizes both,
#: which takes minutes on a laptop; the cap only exists so a wedged run cannot
#: hold the download thread forever.
_EXPORT_TIMEOUT_S = 3600


def _export_command(script: str, dest: str) -> list[str]:
    """Command that runs the export, preferring the venv's own toolchain.

    `onnx`/`onnxscript` are declared in pyproject so a packaged build has them,
    but a dev checkout may not have synced since they were added. `uv run
    --with` supplies them for that one run instead of failing the export.
    """
    args = [script, "--model-dir", dest, "--prune-weights"]
    try:
        import onnx  # noqa: F401
        import onnxscript  # noqa: F401

        return [sys.executable, *args]
    except ImportError:
        pass
    uv = shutil.which("uv")
    if not uv:
        return [sys.executable, *args]
    return [uv, "run", "--with", "onnx", "--with", "onnxscript", "python", *args]


def _export_decision_onnx(dest: str) -> None:
    """Convert a freshly downloaded Laya checkpoint to ONNX.

    The native router loads an ONNX graph, not the torch checkpoint, so a
    download on its own would leave the decision slot unusable. Running the
    export here keeps the old "download it and it works" behaviour.

    Runs as a subprocess on purpose: the export peaks at a few GB while torch
    builds and quantizes the graph, and that memory must not sit inside the
    sidecar (already the largest process on the machine).
    """
    import subprocess

    script = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "scripts",
        "export-laya-onnx.py",
    )
    if not os.path.isfile(script):
        print(f"[models] export script not found at {script}", flush=True)
        return
    print(f"[models] exporting {dest} to ONNX (one-time, takes a few minutes)", flush=True)
    try:
        proc = subprocess.run(
            _export_command(script, dest),
            capture_output=True,
            text=True,
            timeout=_EXPORT_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        print("[models] onnx export timed out", flush=True)
        return
    for line in (proc.stdout or "").strip().splitlines()[-4:]:
        print(f"[models] export: {line}", flush=True)
    if proc.returncode != 0:
        print(
            f"[models] onnx export failed: {(proc.stderr or '').strip()[-300:]}",
            flush=True,
        )


def _make_tqdm_class(kind: str, controls: dict[str, threading.Event]):
    """کلاس پروگرس سازگار با ``snapshot_download`` که بایت، درصد و سرعت را
    ثبت می‌کند و به پرچم‌های مکث/توقف واکنش نشان می‌دهد.

    ``snapshot_download`` نوارهای سطح بالا (انتقال/بازسازی) و نوار تعداد
    فایل‌ها را با همین کلاس می‌سازد؛ فقط نوار بایتی بازسازی شمرده می‌شود تا
    دوباره‌شماری نشود. چون ``update`` همگام در حلقه دانلود صدا زده می‌شود،
    خوابیدن حین مکث عملاً شبکه را هم متوقف می‌کند و پرتاب خطا حین توقف،
    نخ‌های ``hf_thread_map`` را آزاد می‌کند. فایل‌های نیمه‌تمام روی دیسک
    می‌مانند تا اجرای بعدی با Range خودکار ادامه دهد.
    """

    class _KindTqdm:
        def __init__(self, *args, **kwargs) -> None:
            desc = str(kwargs.get("desc") or "")
            unit = kwargs.get("unit")
            self._track = unit == "B" and desc != "Downloading bytes"
            try:
                self.total = float(kwargs.get("total") or 0)
            except (TypeError, ValueError):
                self.total = 0
            try:
                self.n = float(kwargs.get("initial") or 0)
            except (TypeError, ValueError):
                self.n = 0
            self.format_dict: dict = {}
            if self.total > 0:
                _sync_total(kind, self.total)
            if self._track and self.n > 0:
                _record_bytes(kind, self.n, self.total)

        def __enter__(self):
            return self

        def __exit__(self, *exc) -> None:
            return None

        def _check_controls(self) -> None:
            while controls["pause"].is_set():
                if controls["cancel"].is_set():
                    raise _DownloadCancelled()
                time.sleep(0.1)
            if controls["cancel"].is_set():
                raise _DownloadCancelled()

        def update(self, n=None) -> None:
            self._check_controls()
            try:
                inc = float(n if n is not None else 1)
            except (TypeError, ValueError):
                inc = 0
            self.n += inc
            if self._track and inc:
                _record_bytes(kind, inc, self.total)

        def update_transfer(self, n=None) -> None:
            self.update(n)

        def set_postfix_str(self, *args, **kwargs) -> None:
            return None

        def set_transfer_postfix_str(self, *args, **kwargs) -> None:
            return None

        def set_description(self, desc=None, *args, **kwargs) -> None:
            return None

        def refresh(self) -> None:
            return None

        def close(self) -> None:
            return None

    return _KindTqdm


def start_download(kind: str, repo: str, base_url: str = "") -> bool:
    """Start a background ``snapshot_download``. Returns True when launched.

    ``repo`` must be a non-empty HuggingFace repo id. ``base_url`` is an
    optional HF mirror endpoint (e.g. ``https://hf-mirror.com``). A repeat
    call for the same repo while downloading is a no-op (True). A paused
    download of the same repo resumes. Partial files on disk are resumed
    automatically via HTTP Range.
    """
    repo = (repo or "").strip()
    if not repo:
        return False
    kind = kind or KIND_EMBEDDING
    base_url = (base_url or "").strip()

    with _LOCK:
        cur = _STATES.get(kind)
        if cur and cur.get("state") == "downloading" and cur.get("repo") == repo:
            return True
        if cur and cur.get("state") == "paused" and cur.get("repo") == repo:
            controls = _controls_for(kind)
            controls["pause"].clear()
            _set_resumed(kind)
            print(f"[models] {kind} download resumed", flush=True)
            return True
        run = _RUNS.get(kind, 0) + 1
        _RUNS[kind] = run
        controls = _controls_for(kind)
        controls["pause"].clear()
        controls["cancel"].clear()

    if kind == KIND_WHISPER:
        dest = whisper_dir()
    elif kind == KIND_DECISION:
        dest = _decision_dir(repo)
    else:
        dest = _embedding_dir(repo)
    _set_downloading(kind, repo, base_url, _dir_size(dest))
    # NOTE: decision (Laya) downloads use the release folder layout
    # laya--<org>--<name>, so pause/resume/remove work through the same helpers.
    tqdm_class = _make_tqdm_class(kind, controls)

    def _run() -> None:
        try:
            from huggingface_hub import snapshot_download

            print(f"[models] downloading {repo}\n  -> {dest}", flush=True)
            snapshot_download(
                repo_id=repo,
                local_dir=dest,
                local_dir_use_symlinks=False,
                endpoint=base_url or None,
                max_workers=_SNAPSHOT_MAX_WORKERS,
                etag_timeout=_SNAPSHOT_ETAG_TIMEOUT,
                ignore_patterns=_DECISION_IGNORE if kind == KIND_DECISION else None,
                tqdm_class=tqdm_class,  # type: ignore[arg-type]
            )
            print(f"[models] {kind} download finished", flush=True)
            if kind == KIND_DECISION:
                _export_decision_onnx(dest)
            with _LOCK:
                if _RUNS.get(kind) == run:
                    _clear_state(kind)
        except _DownloadCancelled:
            print(f"[models] {kind} download cancelled", flush=True)
            with _LOCK:
                if _RUNS.get(kind) == run:
                    _clear_state(kind)
        except Exception as exc:  # noqa: BLE001 — surfaced via /models/status
            print(f"[models] {kind} download failed: {exc}", flush=True)
            with _LOCK:
                if _RUNS.get(kind) == run:
                    _set_error(kind, repo, str(exc))

    threading.Thread(target=_run, name=f"model-dl-{kind}", daemon=True).start()
    return True


def pause_download(kind: str) -> bool:
    """مکث دانلود در حال اجرا؛ بایت‌های گرفته‌شده حفظ می‌شوند."""
    controls = _controls_for(kind)
    with _LOCK:
        st = _STATES.get(kind)
        if not st or st.get("state") != "downloading":
            return False
    controls["pause"].set()
    return _set_paused(kind)


def resume_download(kind: str) -> bool:
    """ادامه دانلود مکث‌شده از همان نیمه (بدون شروع دوباره)."""
    controls = _controls_for(kind)
    with _LOCK:
        st = _STATES.get(kind)
        if not st or st.get("state") != "paused":
            return False
    controls["pause"].clear()
    return _set_resumed(kind)


def cancel_download(kind: str) -> bool:
    """Stop an in-flight download immediately; partial files stay for resume."""
    with _LOCK:
        st = _STATES.get(kind)
        if not st or st.get("state") not in ("downloading", "paused", "error"):
            # Idempotent: nothing running counts as already stopped.
            return True
        if st.get("state") == "error":
            _clear_state(kind)
            return True
        run = _RUNS.get(kind, 0) + 1
        _RUNS[kind] = run
        controls = _controls_for(kind)
        controls["cancel"].set()
        controls["pause"].clear()
        # Clear immediately so /models/status reflects the stop at once.
        # The background thread still sees the cancel flag and exits quietly;
        # its generation check prevents it from touching any future download.
        _clear_state(kind)
    # Outside the lock: close the shared HF httpx session so any request
    # currently blocked inside huggingface_hub fails fast instead of hanging
    # in connect/read until its own timeout. The session is recreated lazily
    # on the next download, so this is safe for future runs.
    _abort_hf_session()
    with _LOCK:
        return True


def remove(kind: str, repo: str) -> bool:
    """Delete a model folder (whisper uses its fixed dir). Returns True when
    something was actually removed."""
    with _LOCK:
        _RUNS[kind] = _RUNS.get(kind, 0) + 1
        controls = _CONTROLS.get(kind)
        if controls is not None:
            controls["cancel"].set()
            controls["pause"].clear()
    if kind == KIND_WHISPER:
        target = whisper_dir()
    elif kind == KIND_DECISION:
        target = _decision_dir(repo)
    else:
        target = _embedding_dir(repo)
    if not os.path.isdir(target):
        _clear_state(kind)
        return False
    _clear_state(kind)
    try:
        shutil.rmtree(target, ignore_errors=True)
        if not os.path.isdir(target):
            _REMOVED_BY_APP.add(os.path.basename(os.path.normpath(target)))
            logger.warning("model removed by user request kind=%s repo=%s", kind, repo)
            return True
        return False
    except OSError:  # pragma: no cover - best effort
        return False


def _dir_size(path: str) -> int:
    total = 0
    if not os.path.isdir(path):
        return 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:  # incompatible xattrs / vanished files
                pass
    return total


def whisper_ready() -> bool:
    """True when the Whisper dir holds a usable weight file.

    Requires a non-empty ``model.bin`` / ``model.safetensors`` / ``model.onnx``
    (not just any fragment such as configs or ``.cache`` partials), so a
    half-downloaded dir correctly reports incomplete and the Settings card
    keeps offering Download (= resume via HTTP Range).
    """
    wdir = whisper_dir()
    if not os.path.isdir(wdir):
        return False
    for name in ("model.bin", "model.safetensors", "model.onnx"):
        try:
            top = os.path.join(wdir, name)
            if os.path.isfile(top) and os.path.getsize(top) > 0:
                return True
            # Snapshot layouts may nest weights one level deeper
            # (e.g. snapshots/<hash>/model.bin) after a mirror download.
            # Shallow walk only (top + one level): a full recursive walk over
            # a multi-GB models tree adds seconds before every transcribe.
            try:
                for child in os.listdir(wdir):
                    cand = os.path.join(wdir, child)
                    try:
                        if os.path.isfile(cand):
                            continue
                        if not os.path.isdir(cand):
                            continue
                        nested = os.path.join(cand, name)
                        if os.path.isfile(nested) and os.path.getsize(nested) > 0:
                            return True
                    except OSError:
                        continue
            except OSError:
                continue
        except OSError:
            continue
    return False


def _embed_ready(root: str) -> bool:
    """True when ``root`` holds a usable e5 ONNX model (snapshots or flat)."""
    snapshots = os.path.join(root, "snapshots")
    if os.path.isdir(snapshots):
        for d in os.listdir(snapshots):
            cand = os.path.join(snapshots, d)
            if os.path.isdir(cand) and os.path.isfile(
                os.path.join(cand, "onnx", "model.onnx")
            ):
                return True
    return os.path.isfile(os.path.join(root, "tokenizer.json")) and os.path.isfile(
        os.path.join(root, "onnx", "model.onnx")
    )


def embedding_dirs() -> list[dict]:
    """All downloaded embedding model dirs, newest first."""
    out: list[dict] = []
    root_dir = _models_dir()
    if not os.path.isdir(root_dir):
        return out
    for name in sorted(os.listdir(root_dir), reverse=True):
        if not name.startswith("models--"):
            continue
        root = os.path.join(root_dir, name)
        if not os.path.isdir(root):
            continue
        repo = name[len("models--") :].replace("--", "/")
        if repo == DECISION_DEFAULT_REPO:
            # The decision model (Laya) has its own Settings card; never list
            # it there as an (always-incomplete) embedding build.
            continue
        out.append(
            {
                "repo": repo,
                "dir": name,
                "size": _dir_size(root),
                "ready": _embed_ready(root),
            }
        )
    return out


def decision_model_dir() -> str:
    """Absolute path to a ready Laya decision-model dir; '' when none.

    Prefers the newest ready dir from :func:`decision_dirs` and resolves it
    to the concrete folder holding the weights (a ``snapshots/<rev>``
    subdir or the flat repo root), mirroring ``embeddings.model_dir``.
    """
    for entry in decision_dirs():
        if not entry.get("ready"):
            continue
        name = str(entry.get("dir") or "")
        if not name:
            continue
        root = os.path.join(_models_dir(), name)
        snapshots = os.path.join(root, "snapshots")
        if os.path.isdir(snapshots):
            for rev in sorted(os.listdir(snapshots), reverse=True):
                cand = os.path.join(snapshots, rev)
                if os.path.isdir(cand) and _dir_has_weights(cand):
                    return cand
        if _dir_has_weights(root):
            return root
    return ""


def decision_dirs() -> list[dict]:
    """Downloaded decision-model dirs (Laya).

    The folder uses the official release layout ``<model>--<org>--<name>``
    (e.g. ``laya--convaiinnovations--laya``) so a manually downloaded copy
    is found as-is; the decision slot is pinned to the default Laya repo
    (there is no per-repo picker for it), so at most one dir can exist.
    """
    out: list[dict] = []
    root_dir = _models_dir()
    name = _decision_dirname(DECISION_DEFAULT_REPO)
    root = os.path.join(root_dir, name)
    if name and os.path.isdir(root):
        out.append(
            {
                "repo": DECISION_DEFAULT_REPO,
                "dir": name,
                "size": _dir_size(root),
                "ready": _decision_ready(root),
                "exported": _decision_exported(root),
            }
        )
    return out


def _decision_exported(root: str) -> bool:
    """True when the ONNX graph the native router loads is present.

    The downloader fetches the torch checkpoint; the native router needs the
    ONNX export of it (``scripts/export-laya-onnx.py``). Reporting the two
    separately lets the Settings card tell "not downloaded" apart from
    "downloaded but not exported yet", which need different actions.
    """
    for sub in ("", "multilingual"):
        d = os.path.join(root, sub) if sub else root
        for name in ("model.int8.onnx", "model.onnx"):
            if os.path.isfile(os.path.join(d, "onnx", name)):
                return True
    return False


def _decision_ready(root: str) -> bool:
    """True when ``root`` holds a usable decision model (snapshots or flat).

    Laya ships safetensors weights plus tokenizer/config files; a half-
    downloaded dir (only configs / .cache partials) must report incomplete so
    the Settings card keeps offering Download (= resume via HTTP Range).
    """
    snapshots = os.path.join(root, "snapshots")
    if os.path.isdir(snapshots):
        for d in os.listdir(snapshots):
            cand = os.path.join(snapshots, d)
            if not os.path.isdir(cand):
                continue
            if _dir_has_weights(cand):
                return True
        return False
    return _dir_has_weights(root)


def _dir_has_weights(root: str) -> bool:
    """Non-empty weight file (safetensors / bin / onnx) under root.

    The ONNX graphs the native router loads live in an ``onnx/`` subfolder, and
    the torch checkpoints they were exported from may have been pruned
    afterwards (``export-laya-onnx.py --prune-weights``), so either layout
    counts as ready — otherwise a pruned install would look incomplete and the
    Settings card would keep offering a download that is already done.
    """
    candidates = [
        os.path.join(root, name)
        for name in ("model.safetensors", "pytorch_model.bin", "model.bin", "model.onnx")
    ]
    candidates += [
        os.path.join(root, "onnx", name) for name in ("model.int8.onnx", "model.onnx")
    ]
    for path in candidates:
        try:
            if os.path.isfile(path) and os.path.getsize(path) > 0:
                return True
        except OSError:
            continue
    return False


def status() -> dict:
    """Complete state for the Settings UI: per-kind download status + dirs."""
    _migrate_legacy_models()
    embed: dict = {"dirs": embedding_dirs()}
    if download_state(KIND_EMBEDDING):
        embed["running"] = download_state(KIND_EMBEDDING)

    decision: dict = {"dirs": decision_dirs()}
    if download_state(KIND_DECISION):
        decision["running"] = download_state(KIND_DECISION)

    whisper: dict = {"dirs": []}
    if download_state(KIND_WHISPER):
        whisper["running"] = download_state(KIND_WHISPER)
    wdir = whisper_dir()
    wmodel = _user_whisper_model()
    if os.path.isdir(wdir):
        whisper["dirs"] = [
            {
                "repo": wmodel,
                "dir": os.path.basename(wdir),
                "size": _dir_size(wdir),
                "ready": whisper_ready(),
            }
        ]
    out = {"whisper": whisper, "embedding": embed, "decision": decision}
    try:
        _tripwire_external_deletion(out)
    except Exception:  # noqa: BLE001, S110 — diagnostics never break status
        pass
    return out


def _witness_path() -> str:
    """Sidecar-persistent witness file (sibling of models/, never inside it)."""
    try:
        root = _raw_models_root()
    except Exception:  # noqa: BLE001 — witness is optional
        return ""
    if not root:
        return ""
    return os.path.join(os.path.dirname(root), "models-watch.json")


def _tripwire_external_deletion(status_out: dict) -> None:
    """Warn once when a previously-ready model dir vanishes on its own.

    State persists in models-watch.json so disappearances survive sidecar
    restarts: each status() records which dirs are ready now, and a dir that
    was ready before but is gone now (without a remove() call) gets one
    WARNING in codifa.log with its last-seen timestamp. Codifa itself never
    deletes model dirs except via remove(), so a warning here points outside
    the app (system cleaner, another process, manual delete).
    """
    ready_now: set[str] = set()
    for _section in (
        status_out.get("embedding") or {},
        status_out.get("decision") or {},
    ):
        for _d in (_section.get("dirs") or []):
            _name = str((_d or {}).get("dir") or "")
            if _name and (_d or {}).get("ready"):
                ready_now.add(_name)
    for _w in (status_out.get("whisper", {}) or {}).get("dirs", []) or []:
        _name = str((_w or {}).get("dir") or "")
        if _name and (_w or {}).get("ready"):
            ready_now.add(_name)

    _path = _witness_path()
    _witness: dict = {}
    if _path:
        try:
            if os.path.isfile(_path):
                with open(_path, encoding="utf-8") as _fh:
                    _loaded = json.load(_fh)
                if isinstance(_loaded, dict):
                    _witness = _loaded
        except Exception:  # noqa: BLE001 — corrupt witness starts over
            _witness = {}
    _prev_ready = _witness.get("ready") or {}
    if not isinstance(_prev_ready, dict):
        _prev_ready = {}
    _warned = set(_witness.get("warned") or [])
    _now = time.time()
    for _name in sorted(set(_prev_ready) - ready_now - _REMOVED_BY_APP):
        if _name in _warned:
            continue
        _warned.add(_name)
        _last = _prev_ready.get(_name)
        try:
            _when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(float(_last)))
        except Exception:  # noqa: BLE001
            _when = "unknown time"
        logger.warning(
            "model dir '%s' vanished WITHOUT a Codifa remove call "
            "(last seen ready %s; external deletion suspected — "
            "check system cleaners / manual deletes)",
            _name,
            _when,
        )
    # A re-downloaded dir leaves the warned set so a later disappearance warns again.
    _warned.intersection_update(set(_prev_ready) - ready_now)
    if _path:
        try:
            # Gone dirs stay recorded with their last-seen timestamp (the
            # evidence); warned entries never re-warn for the same absence.
            _merged = {**_prev_ready, **{n: _now for n in ready_now}}
            with open(_path, "w", encoding="utf-8") as _fh:
                json.dump({"ready": _merged, "warned": sorted(_warned)}, _fh)
        except Exception:  # noqa: BLE001, S110 — witness is best-effort
            pass