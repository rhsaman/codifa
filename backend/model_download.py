"""Download / inspect / remove the on-device ML models.

Two models are managed:

* **Whisper** (voice input) — a faster-whisper / CTranslate2 snapshot in
  ``backend/whisper/`` (default repo ``Systran/faster-whisper-medium``).
* **Embedding** (RAG memory / web recall) — an e5-style ONNX model in an
  HF-cache-style folder ``backend/models--<org>--<name>/`` (default
  ``intfloat/multilingual-e5-base``). Every downloaded repo keeps its own
  folder, so several builds can coexist and be removed independently.

Downloads use ``huggingface_hub.snapshot_download`` (the same mechanism as
``download-whisper.py``) and support arbitrary HF mirror endpoints via the
``base_url`` field. Work runs on a background thread and state is tracked
in-memory so the Settings UI can poll ``/models/status``.

This file never auto-downloads — models are fetched only when the user asks.
"""

from __future__ import annotations

import os
import re
import shutil
import threading

_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = _MODULE_DIR

KIND_WHISPER = "whisper"
KIND_EMBEDDING = "embedding"

WHISPER_DEFAULT_REPO = "Systran/faster-whisper-medium"
EMBEDDING_DEFAULT_REPO = "intfloat/multilingual-e5-base"


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
                _migrated = True
    return target


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


# --- live download state (one entry per kind) --------------------------- #
# {"state": "downloading"|"error", "repo": str, "error": str}
_STATES: dict[str, dict] = {}
_LOCK = threading.Lock()


def download_state(kind: str) -> dict | None:
    with _LOCK:
        return dict(_STATES[kind]) if kind in _STATES else None


def _set_downloading(kind: str, repo: str) -> None:
    with _LOCK:
        _STATES[kind] = {"state": "downloading", "repo": repo, "error": ""}


def _set_error(kind: str, repo: str, error: str) -> None:
    with _LOCK:
        _STATES[kind] = {"state": "error", "repo": repo, "error": error}


def _clear_state(kind: str) -> None:
    with _LOCK:
        _STATES.pop(kind, None)


def start_download(kind: str, repo: str, base_url: str = "") -> bool:
    """Start a background ``snapshot_download``. Returns True when launched.

    ``repo`` must be a non-empty HuggingFace repo id. ``base_url`` is an
    optional HF mirror endpoint (e.g. ``https://hf-mirror.com``).
    """
    repo = (repo or "").strip()
    if not repo:
        return False
    kind = kind or KIND_EMBEDDING

    def _run() -> None:
        _set_downloading(kind, repo)
        dest = whisper_dir() if kind == KIND_WHISPER else _embedding_dir(repo)
        try:
            from huggingface_hub import snapshot_download

            print(f"[models] downloading {repo}\\n  -> {dest}", flush=True)
            snapshot_download(
                repo_id=repo,
                local_dir=dest,
                local_dir_use_symlinks=False,
                endpoint=(base_url or "").strip() or None,
            )
            print(f"[models] {kind} download finished", flush=True)
            _clear_state(kind)
        except Exception as exc:  # noqa: BLE001 — surfaced via /models/status
            print(f"[models] {kind} download failed: {exc}", flush=True)
            _set_error(kind, repo, str(exc))

    threading.Thread(target=_run, name=f"model-dl-{kind}", daemon=True).start()
    return True


def remove(kind: str, repo: str) -> bool:
    """Delete a model folder (whisper uses its fixed dir). Returns True when
    something was actually removed."""
    target = whisper_dir() if kind == KIND_WHISPER else _embedding_dir(repo)
    if not os.path.isdir(target):
        return False
    _clear_state(kind)
    try:
        shutil.rmtree(target, ignore_errors=True)
        return not os.path.isdir(target)
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
    """True when a non-empty Whisper model dir exists (a big ``model.bin``)."""
    wdir = whisper_dir()
    if not os.path.isdir(wdir):
        return False
    return any(
        os.path.isfile(os.path.join(wdir, f))
        and os.path.getsize(os.path.join(wdir, f)) > 0
        for f in os.listdir(wdir)
    )


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
        out.append(
            {
                "repo": repo,
                "dir": name,
                "size": _dir_size(root),
                "ready": _embed_ready(root),
            }
        )
    return out


def status() -> dict:
    """Complete state for the Settings UI: per-kind download status + dirs."""
    _migrate_legacy_models()
    embed: dict = {"dirs": embedding_dirs()}
    if download_state(KIND_EMBEDDING):
        embed["running"] = download_state(KIND_EMBEDDING)

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
    return {"whisper": whisper, "embedding": embed}