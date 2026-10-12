"""On-device local TTS provider registry.

Swappable design so the local model can be changed later with one line:
set ``ACTIVE_LOCAL_TTS_ID`` to another entry in ``LOCAL_TTS_PROVIDERS``.

Current active provider: ``pocket-farsi-v2`` (mehdi-hf/pocket-tts-farsi-v2).
Legacy Piper voices (fa_IR-*) are kept as a fallback entry so old downloads
keep working, but new installs use pocket v2 with a bundled default voice.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import deque
from pathlib import Path

logger = logging.getLogger("local_tts")

# Silence one-time download/progress noise: the repeated "Loading weights"
# bars are normal, not errors. Harmless when the packages are absent.
# Assigned (not setdefault) so a pre-set leaky env cannot re-enable bars.
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
os.environ["TRANSFORMERS_VERBOSITY"] = "error"
os.environ["TQDM_DISABLE"] = "1"
os.environ["TRANSFORMERS_NO_ADVISORY_WARNINGS"] = "1"

# Active local TTS provider id. Change this to swap the local model later.
ACTIVE_LOCAL_TTS_ID = "pocket-farsi-v2"

# Pocket Farsi v2 (must stay v2 per product requirement).
POCKET_REPO = "mehdi-hf/pocket-tts-farsi-v2"
POCKET_G2P_REPO = "mehdi-hf/Homo-GE2PE-Persian-HF"
POCKET_DEFAULT_VOICE = "default"
# Pocket v2 chunk budget (model card): training utterances averaged ~11
# tokens, 18 is the safe ceiling -- at 21+ generations stop terminating and
# turn into runaway noise. Never raise this for speed.
POCKET_MAX_CHUNK_TOKENS = 18
# pocket appends terminal punctuation to every chunk (+1 token): an
# 18-token split becomes 19 and pocket warns "generation may skip words".
# Split one token below the ceiling to leave room for it.
POCKET_SPLIT_BUDGET_TOKENS = POCKET_MAX_CHUNK_TOKENS - 1
# Files needed from the pocket repo (snapshot_download allow_patterns).
POCKET_FILES = (
    "model.safetensors",
    "model.yaml",
    "tokenizer_ph.model",
    "normalize_fa.py",
)
# Bundled default voice prompt (<=5s, required by pocket v2).
POCKET_DEFAULT_PROMPT_SRC = "samples/prompt_hello.wav"

# Legacy Piper defaults (kept for backward compat with existing downloads).
DEFAULT_PIPER_VOICE = "fa_IR-amir-medium"
PIPER_VOICES_REPO = "rhasspy/piper-voices"

# Download kind used by the /models/* routes (kept as "piper" for API compat;
# the frontend polls ModelsStatus.piper). New code should treat it as
# "local-tts" alias.
_PIPER_KIND = "piper"

LOCAL_TTS_PROVIDERS: dict[str, dict] = {
    "pocket-farsi-v2": {
        "repo": POCKET_REPO,
        "g2p_repo": POCKET_G2P_REPO,
        "display": "Pocket Farsi v2 (offline)",
        "sample_rate": 24000,
    },
    "piper-fa": {
        "repo": PIPER_VOICES_REPO,
        "display": "Piper fa (legacy offline)",
        "default_voice": DEFAULT_PIPER_VOICE,
    },
}

_DOWNLOAD_STATE: dict = {
    "state": "idle",
    "model": "",
    "progress": 0.0,
    "error": "",
    "downloaded_bytes": 0,
    "total_bytes": 0,
    "speed_bps": 0.0,
}
_RUNTIME: dict = {"thread": None, "cancel": False, "paused": False}

# Download controls mirroring backend/model_download.py so pause/stop
# actually interrupt the HF transfer instead of looking dead.
_DOWNLOAD_KIND = "piper"
_LOCK = threading.RLock()
_G2P_LOCK = threading.Lock()
_MODEL_LOCK = threading.Lock()
# pocket's generate_audio is documented as NOT thread-safe: concurrent
# synthesis corrupts the shared model state and generation hangs without
# EOS (speech stops mid-sentence). One synthesis at a time per process.
_SYNTH_LOCK = threading.Lock()
_RUNS: dict[str, int] = {}
_CONTROLS: dict[str, dict[str, threading.Event]] = {}
_SPEED_SAMPLES: dict[str, deque] = {}


class _DownloadCancelled(Exception):
    """Internal cancel signal (never shown as an error in the UI)."""


_ORIG_SLEEP = time.sleep


def _cancellable_sleep(seconds: float) -> None:
    try:
        name = threading.current_thread().name
    except Exception:  # noqa: BLE001 - never break sleep
        _ORIG_SLEEP(seconds)
        return
    if not name.startswith("model-dl-"):
        _ORIG_SLEEP(seconds)
        return
    try:
        controls = _CONTROLS.get(_DOWNLOAD_KIND)
    except Exception:  # noqa: BLE001 - never break sleep
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


time.sleep = _cancellable_sleep  # type: ignore[method-assign]


def _controls_for() -> dict[str, threading.Event]:
    with _LOCK:
        entry = _CONTROLS.get(_DOWNLOAD_KIND)
        if entry is None:
            entry = {"pause": threading.Event(), "cancel": threading.Event()}
            _CONTROLS[_DOWNLOAD_KIND] = entry
        return entry


def _abort_hf_session() -> None:
    """Best-effort abort of in-flight HF HTTP requests on cancel."""
    try:
        from huggingface_hub.utils._http import close_session

        close_session()
    except Exception:  # noqa: BLE001, S110 - abort is best-effort only
        pass


def _record_bytes(n: float, total_hint: float = 0) -> None:
    """Record downloaded bytes and update percent and speed (thread-safe)."""
    try:
        inc = float(n or 0)
    except (TypeError, ValueError):
        return
    now = time.monotonic()
    with _LOCK:
        downloaded = float(_DOWNLOAD_STATE.get("downloaded_bytes") or 0) + inc
        total = float(_DOWNLOAD_STATE.get("total_bytes") or 0)
        try:
            hint = float(total_hint or 0)
        except (TypeError, ValueError):
            hint = 0
        total = max(total, hint)
        downloaded = max(downloaded, 0)
        _DOWNLOAD_STATE["downloaded_bytes"] = int(downloaded)
        _DOWNLOAD_STATE["total_bytes"] = int(total)
        if total > 0:
            frac = min(1.0, downloaded / total)
            _DOWNLOAD_STATE["progress"] = round(frac, 4)
        samples = _SPEED_SAMPLES.get(_DOWNLOAD_KIND)
        if samples is None:
            samples = deque(maxlen=120)
            _SPEED_SAMPLES[_DOWNLOAD_KIND] = samples
        samples.append((now, downloaded))
        cutoff = now - 5.0
        while len(samples) >= 2 and samples[0][0] < cutoff:
            samples.popleft()
        if len(samples) >= 2:
            dt = samples[-1][0] - samples[0][0]
            db = samples[-1][1] - samples[0][1]
            speed = db / dt if dt > 0.05 else 0.0
            _DOWNLOAD_STATE["speed_bps"] = speed if speed > 0 else 0.0
        else:
            _DOWNLOAD_STATE["speed_bps"] = 0.0


def _sync_total(total: float) -> None:
    """Sync total size when the progress bar reports a larger total."""
    try:
        total = float(total or 0)
    except (TypeError, ValueError):
        return
    if total <= 0:
        return
    with _LOCK:
        if total > float(_DOWNLOAD_STATE.get("total_bytes") or 0):
            _DOWNLOAD_STATE["total_bytes"] = int(total)
            downloaded = float(_DOWNLOAD_STATE.get("downloaded_bytes") or 0)
            if total > 0:
                _DOWNLOAD_STATE["progress"] = round(min(1.0, downloaded / total), 4)

# Cached pocket model + voice state (kept in memory between requests).
_POCKET_MODEL = None
_POCKET_VOICE_STATE = None
_POCKET_VOICE_KEY = ""
# Cached G2P tokenizer + model: loading T5 weights on every request caused
# the repeated "Loading weights: 0/52" log and TTS errors under load.
_G2P_TOK = None
_G2P_MODEL = None

# Idle eviction: the pocket model + G2P weights hold a large amount of RAM,
# so keeping them resident forever in a long-lived sidecar dominates the
# app's memory. After this many seconds without a synth call the cached
# models are dropped; the next call simply reloads them lazily (same audio).
try:
    _TTS_IDLE_EVICT_S = float(os.environ.get("TTS_IDLE_EVICT_S") or 5 * 60)
except (TypeError, ValueError):
    _TTS_IDLE_EVICT_S = float(5 * 60)
_tts_last_used = 0.0
_tts_evict_timer = None


def _tts_touch() -> None:
    """Record TTS activity and (re)arm the idle-eviction timer."""
    global _tts_last_used, _tts_evict_timer
    with _LOCK:
        _tts_last_used = time.monotonic()
        if _tts_evict_timer is not None:
            _tts_evict_timer.cancel()
        _tts_evict_timer = threading.Timer(_TTS_IDLE_EVICT_S, _evict_tts_if_idle)
        _tts_evict_timer.daemon = True
        _tts_evict_timer.start()


def _evict_tts_if_idle() -> None:
    """Drop cached TTS models after a full idle window; next use reloads.

    Safe mid-synthesis: callers use local references, so clearing the
    globals only affects the next call, which lazily reloads everything.
    """
    global _POCKET_MODEL, _POCKET_VOICE_STATE, _POCKET_VOICE_KEY, _G2P_TOK, _G2P_MODEL
    with _LOCK:
        if _POCKET_MODEL is None and _G2P_MODEL is None:
            return
        if time.monotonic() - _tts_last_used < _TTS_IDLE_EVICT_S:
            return
        _POCKET_MODEL = None
        _POCKET_VOICE_STATE = None
        _POCKET_VOICE_KEY = ""
        _G2P_TOK = None
        _G2P_MODEL = None
    import gc

    gc.collect()


def active_provider_id() -> str:
    """Return the active local TTS provider id."""
    return ACTIVE_LOCAL_TTS_ID


def default_voice_id() -> str:
    """Default voice id for the active provider."""
    if ACTIVE_LOCAL_TTS_ID == "pocket-farsi-v2":
        return POCKET_DEFAULT_VOICE
    return DEFAULT_PIPER_VOICE


def normalize_voice_id(voice_id: str) -> str:
    """Normalize a voice id for the active provider."""
    cleaned = (voice_id or "").strip()
    if ACTIVE_LOCAL_TTS_ID == "pocket-farsi-v2":
        if not cleaned or cleaned.lower() == "local":
            return POCKET_DEFAULT_VOICE
        # Legacy Piper ids migrate to the bundled pocket default voice.
        if cleaned.startswith("fa_IR"):
            return POCKET_DEFAULT_VOICE
        # Accept full onnx legacy names during migration.
        if cleaned.endswith((".onnx.json", ".onnx")):
            return POCKET_DEFAULT_VOICE
        # HF repo ids are accepted as-is (future multi-model support).
        if "/" in cleaned:
            return cleaned
        return cleaned or POCKET_DEFAULT_VOICE
    # Legacy piper path.
    if cleaned.endswith(".onnx.json"):
        cleaned = cleaned[: -len(".onnx.json")]
    elif cleaned.endswith(".onnx"):
        cleaned = cleaned[: -len(".onnx")]
    if not cleaned:
        cleaned = DEFAULT_PIPER_VOICE
    return cleaned


def _primary_local_tts_dir() -> Path:
    """Primary on-device TTS dir, respecting the app data root."""
    env_dir = os.environ.get("LOCAL_TTS_DIR", "").strip() or os.environ.get(
        "PIPER_VOICE_DIR", ""
    ).strip()
    if env_dir:
        return Path(env_dir)
    try:
        from state_db import data_root

        return Path(data_root()) / "models" / "pocket-farsi-v2"
    except Exception:  # noqa: BLE001 - standalone fallback
        return Path.home() / ".codifa" / "models" / "pocket-farsi-v2"


def _candidate_local_tts_dirs() -> list[Path]:
    """All dirs that may hold a pocket snapshot (primary + legacy home)."""
    primary = _primary_local_tts_dir()
    legacy = Path.home() / ".codifa" / "models" / "pocket-farsi-v2"
    if str(legacy) == str(primary):
        return [primary]
    return [primary, legacy]


def local_tts_dir() -> str:
    """Return the primary pocket dir (or $LOCAL_TTS_DIR)."""
    base = _primary_local_tts_dir()
    try:
        base.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return str(base)


def pocket_model_dir() -> Path:
    """Local dir holding the pocket v2 snapshot."""
    directory = _primary_local_tts_dir() / "models--mehdi-hf--pocket-tts-farsi-v2"
    return directory


def _pocket_model_dirs() -> list[Path]:
    """Snapshot dirs across primary + legacy roots."""
    return [
        base / "models--mehdi-hf--pocket-tts-farsi-v2"
        for base in _candidate_local_tts_dirs()
    ]


def default_prompt_path() -> str:
    """Local path of the bundled default voice prompt."""
    return str(_primary_local_tts_dir() / "default-prompt.wav")


def _default_prompt_candidates() -> list[Path]:
    """Prompt paths across primary + legacy roots."""
    return [base / "default-prompt.wav" for base in _candidate_local_tts_dirs()]


def _ensure_default_prompt(model_dirs: list[Path]) -> Path | None:
    """Self-heal a missing default-prompt.wav from any downloaded sample."""
    for prompt in _default_prompt_candidates():
        try:
            if prompt.is_file():
                return prompt
        except OSError:
            continue
    for model_dir in model_dirs:
        for pattern in ("samples/prompt_hello.wav", "samples/*.wav", "*.wav"):
            try:
                matches = sorted(model_dir.glob(pattern))
            except OSError:
                continue
            for src in matches:
                try:
                    if not src.is_file():
                        continue
                    target = Path(default_prompt_path())
                    try:
                        target.parent.mkdir(parents=True, exist_ok=True)
                    except OSError:
                        pass
                    import shutil

                    shutil.copyfile(src, target)
                    return target
                except OSError:
                    continue
    return None


def _pocket_weights_present() -> Path | None:
    """Return the snapshot dir when weights + config + tokenizer are on disk (prompt ignored)."""
    model_dirs = _pocket_model_dirs()
    # Accept layout variants so a renamed weight/config/tokenizer file never
    # reports a fully downloaded snapshot as missing.
    weight_names = ("model.safetensors", "pytorch_model.bin", "model.bin")
    config_names = ("model.yaml", "config.json")
    tokenizer_names = ("tokenizer_ph.model", "tokenizer.json", "tokenizer.model")

    def _has_shallow(model_dir: Path, names: tuple[str, ...]) -> bool:
        # Direct hit first (normal layout: files sit directly under the
        # snapshot dir). Only when that misses, check one nesting level
        # (snapshots/<hash>/...) instead of a full recursive walk: a full
        # rglob over a multi-GB models tree adds seconds before every
        # synthesis and stalls the first speaker-icon click.
        for name in names:
            try:
                if (model_dir / name).is_file():
                    return True
            except OSError:
                continue
        try:
            if not model_dir.is_dir():
                return False
            for child in model_dir.iterdir():
                try:
                    if child.is_file():
                        continue
                    if not child.is_dir():
                        continue
                    for name in names:
                        if (child / name).is_file():
                            return True
                except OSError:
                    continue
        except OSError:
            pass
        return False

    for model_dir in model_dirs:
        try:
            if not model_dir.is_dir():
                continue
            if (
                _has_shallow(model_dir, weight_names)
                and _has_shallow(model_dir, config_names)
                and _has_shallow(model_dir, tokenizer_names)
            ):
                return model_dir
        except OSError:
            continue
    return None


def _shared_pocket_snapshot() -> Path | None:
    """Pre-layout snapshot directly under the shared data-root models dir."""
    # Targeted checks only: a recursive scan over the shared models dir also
    # walks whisper (~1.5GB) + embeddings on every TTS request and adds
    # seconds before synthesis even starts.
    try:
        from state_db import data_root

        shared = Path(data_root()) / "models"
    except Exception:  # noqa: BLE001 - standalone fallback
        return None
    try:
        if not shared.is_dir():
            return None
        candidates = [
            shared / "models--mehdi-hf--pocket-tts-farsi-v2",
            shared / "pocket-farsi-v2" / "models--mehdi-hf--pocket-tts-farsi-v2",
        ]
        for parent in candidates:
            try:
                if (parent / "model.yaml").is_file() and (parent / "model.safetensors").is_file() and (
                    parent / "tokenizer_ph.model"
                ).is_file():
                    return parent
            except OSError:
                continue
    except OSError:
        return None
    return None


def is_pocket_ready() -> bool:
    """True when model weights + tokenizer + default prompt are on disk."""
    ready_dir = _pocket_weights_present() or _shared_pocket_snapshot()
    if ready_dir is None:
        return False
    try:
        prompt = _ensure_default_prompt([ready_dir, *_pocket_model_dirs()])
        return prompt is not None
    except OSError:
        return False


def _pocket_snapshot_size() -> int:
    """On-disk size of the pocket snapshot in use plus the default prompt.

    Counts only the snapshot dir the synthesizer actually loads, never the
    whole models root: when LOCAL_TTS_DIR points at the shared models dir a
    full-root scan wrongly adds whisper + embeddings to the TTS card size,
    and duplicate copies across roots double it.
    """
    ready = _pocket_weights_present() or _shared_pocket_snapshot()
    if ready is not None:
        dirs = [ready]
    else:
        dirs = [d for d in _pocket_model_dirs() if d.is_dir()]
    seen: set[str] = set()
    total = 0

    def _add(path: Path) -> None:
        nonlocal total
        key = str(path)
        if key in seen:
            return
        seen.add(key)
        try:
            total += path.stat().st_size
        except OSError:
            pass

    for directory in dirs:
        try:
            for path in directory.rglob("*"):
                try:
                    if path.is_file():
                        _add(path)
                except OSError:
                    continue
        except OSError:
            continue
    for prompt in _default_prompt_candidates():
        try:
            if prompt.is_file():
                _add(prompt)
        except OSError:
            continue
    return total


def download_snapshot() -> dict:
    """JSON-serializable copy of the local TTS download state."""
    with _LOCK:
        state = dict(_DOWNLOAD_STATE)
    model = str(state.get("model") or "")
    raw_state = str(state.get("state") or "idle")
    size = 0
    try:
        size = _pocket_snapshot_size()
        if size > 0 and raw_state in ("idle", "", "cancelled") and is_pocket_ready():
            raw_state = "done"
            if not model:
                model = POCKET_REPO
    except OSError as exc:  # size scan is best-effort
        logger.debug("local TTS snapshot scan failed: %s", exc)
    return {
        "state": raw_state,
        "model": model,
        "progress": float(state.get("progress") or 0.0),
        "error": str(state.get("error") or ""),
        "size": size,
        "downloaded_bytes": int(state.get("downloaded_bytes") or 0),
        "total_bytes": int(state.get("total_bytes") or 0),
        "speed_bps": float(state.get("speed_bps") or 0.0),
    }


def _make_tqdm_class(controls: dict[str, threading.Event]):
    """Progress class for snapshot_download that tracks bytes and honors pause/stop."""

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
                _sync_total(self.total)
            if self._track and self.n > 0:
                _record_bytes(self.n, self.total)

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
                _record_bytes(inc, self.total)

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


def _run_download(repo: str, run: int) -> None:
    """Background worker downloading the pocket v2 snapshot + prompt."""
    try:
        with _LOCK:
            _DOWNLOAD_STATE.update(
                {
                    "state": "downloading",
                    "model": repo,
                    "progress": 0.0,
                    "error": "",
                    "downloaded_bytes": 0,
                    "total_bytes": 0,
                    "speed_bps": 0.0,
                }
            )
        controls = _controls_for()
        tqdm_class = _make_tqdm_class(controls)
        from huggingface_hub import snapshot_download

        dest = str(pocket_model_dir())
        snapshot_download(
            repo_id=repo,
            local_dir=dest,
            local_dir_use_symlinks=False,
            allow_patterns=list(POCKET_FILES) + [POCKET_DEFAULT_PROMPT_SRC, "samples/*"],
            max_workers=4,
            tqdm_class=tqdm_class,  # type: ignore[arg-type]
        )
        # Copy the bundled prompt to a stable path.
        import shutil

        candidates = [
            Path(dest) / POCKET_DEFAULT_PROMPT_SRC,
            Path(dest) / "samples" / "prompt_hello.wav",
        ]
        target = Path(default_prompt_path())
        for src in candidates:
            try:
                if src.is_file():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(src, target)
                    break
            except OSError:
                continue
        with _LOCK:
            if _RUNS.get(_DOWNLOAD_KIND) != run:
                return
            if controls["cancel"].is_set():
                _DOWNLOAD_STATE.update({"state": "cancelled", "progress": 0.0})
            else:
                _DOWNLOAD_STATE.update({"state": "done", "progress": 1.0, "error": ""})
    except _DownloadCancelled:
        with _LOCK:
            if _RUNS.get(_DOWNLOAD_KIND) == run:
                _DOWNLOAD_STATE.update({"state": "cancelled", "progress": 0.0})
    except InterruptedError:
        with _LOCK:
            if _RUNS.get(_DOWNLOAD_KIND) == run:
                _DOWNLOAD_STATE.update({"state": "cancelled", "progress": 0.0, "error": ""})
    except Exception as exc:  # noqa: BLE001 - worker must report any failure
        with _LOCK:
            if _RUNS.get(_DOWNLOAD_KIND) == run:
                _DOWNLOAD_STATE.update({"state": "error", "error": f"local TTS download failed: {exc}"})
    finally:
        with _LOCK:
            if _RUNS.get(_DOWNLOAD_KIND) == run:
                _RUNTIME["thread"] = None
                _RUNTIME["cancel"] = False
                _RUNTIME["paused"] = False


def start_download(model: str = "") -> bool:
    """Start a background local TTS download; False for empty id."""
    repo = (model or "").strip() or POCKET_REPO
    # Short voice ids map to the active provider repo.
    if "/" not in repo and "\\" not in repo:
        repo = POCKET_REPO
    if is_pocket_ready() and repo == POCKET_REPO:
        with _LOCK:
            _DOWNLOAD_STATE.update({"state": "done", "model": repo, "progress": 1.0, "error": ""})
        return True
    with _LOCK:
        thread = _RUNTIME.get("thread")
        try:
            alive = thread is not None and thread.is_alive()
        except Exception:  # noqa: BLE001 - thread state check is best-effort
            alive = False
        if alive:
            if _DOWNLOAD_STATE.get("model") == repo:
                return True
            from fastapi import HTTPException

            raise HTTPException(status_code=400, detail="a local TTS download is already in progress")
        run = _RUNS.get(_DOWNLOAD_KIND, 0) + 1
        _RUNS[_DOWNLOAD_KIND] = run
        controls = _controls_for()
        controls["pause"].clear()
        controls["cancel"].clear()
        _RUNTIME["cancel"] = False
        _RUNTIME["paused"] = False
        worker = threading.Thread(
            target=_run_download, args=(repo, run), name=f"model-dl-{_DOWNLOAD_KIND}", daemon=True
        )
        _RUNTIME["thread"] = worker
        worker.start()
        return True


def pause_download() -> bool:
    """Pause the running download; False when nothing is running."""
    controls = _controls_for()
    with _LOCK:
        thread = _RUNTIME.get("thread")
        try:
            alive = thread is not None and thread.is_alive()
        except Exception:  # noqa: BLE001 - thread state check is best-effort
            alive = False
        if not alive or _DOWNLOAD_STATE.get("state") != "downloading":
            return False
    controls["pause"].set()
    with _LOCK:
        _RUNTIME["paused"] = True
        _DOWNLOAD_STATE["state"] = "paused"
        _DOWNLOAD_STATE["speed_bps"] = 0.0
    return True


def resume_download() -> bool:
    """Resume a paused download; False when nothing is paused."""
    controls = _controls_for()
    with _LOCK:
        thread = _RUNTIME.get("thread")
        try:
            alive = thread is not None and thread.is_alive()
        except Exception:  # noqa: BLE001 - thread state check is best-effort
            alive = False
        if not alive or _DOWNLOAD_STATE.get("state") != "paused":
            return False
    controls["pause"].clear()
    with _LOCK:
        _RUNTIME["paused"] = False
        _DOWNLOAD_STATE["state"] = "downloading"
    return True


def cancel_download() -> None:
    """Stop an in-flight download immediately; partial files stay for resume."""
    with _LOCK:
        thread = _RUNTIME.get("thread")
        try:
            alive = thread is not None and thread.is_alive()
        except Exception:  # noqa: BLE001 - thread state check is best-effort
            alive = False
        if not alive:
            _DOWNLOAD_STATE.update({"state": "idle", "progress": 0.0})
            _RUNTIME["cancel"] = False
            _RUNTIME["paused"] = False
            return
        run = _RUNS.get(_DOWNLOAD_KIND, 0) + 1
        _RUNS[_DOWNLOAD_KIND] = run
        controls = _controls_for()
        controls["cancel"].set()
        controls["pause"].clear()
        _DOWNLOAD_STATE.update({"state": "cancelled", "progress": 0.0})
    _abort_hf_session()
    with _LOCK:
        _RUNTIME["cancel"] = True
        _RUNTIME["paused"] = False


def remove_files(voice_id: str = "") -> list[str]:
    """Delete downloaded local TTS files."""
    import shutil

    removed: list[str] = []
    root = Path(local_tts_dir())
    try:
        if root.is_dir():
            shutil.rmtree(root)
            removed.append(str(root))
    except OSError:
        pass
    # Reset cached model so next synth reloads.
    global _POCKET_MODEL, _POCKET_VOICE_STATE, _POCKET_VOICE_KEY
    global _G2P_TOK, _G2P_MODEL, _tts_evict_timer
    if _tts_evict_timer is not None:
        _tts_evict_timer.cancel()
        _tts_evict_timer = None
    _POCKET_MODEL = None
    _POCKET_VOICE_STATE = None
    _POCKET_VOICE_KEY = ""
    _G2P_TOK = None
    _G2P_MODEL = None
    _DOWNLOAD_STATE.update({"state": "idle", "model": "", "progress": 0.0, "error": ""})
    return removed


def resolve_voice_id(model: str = "", voice: str = "", tts_model: str = "", tts_voice: str = "") -> str:
    """Resolve the requested local voice id with frontend-compatible fallbacks."""
    for candidate in (tts_model, model, voice, tts_voice):
        value = (candidate or "").strip()
        if not value:
            continue
        if value.lower() == "local":
            continue
        if value in ("tts-1", "tts-1-hd"):
            continue
        # Remote provider paths are not local voices, except HF repo ids
        # which select the pocket model itself.
        if "/" in value or "\\" in value:
            if value == POCKET_REPO or value.startswith("mehdi-hf/"):
                return POCKET_DEFAULT_VOICE
            continue
        if value.endswith((".onnx.json", ".onnx")):
            continue
        if value:
            return normalize_voice_id(value)
    return default_voice_id()


def _phonemise_fa(text: str) -> str:
    """Convert Persian script to pocket v2 phonemes via Homo-GE2PE."""
    try:
        import torch
        import transformers as _tf
        from transformers import AutoTokenizer, T5ForConditionalGeneration
    except ImportError as exc:
        from fastapi import HTTPException

        raise HTTPException(
            status_code=400,
            detail="pocket-tts G2P dependencies are missing (torch, transformers).",
        ) from exc
    global _G2P_TOK, _G2P_MODEL
    with _G2P_LOCK:
        if _G2P_TOK is None or _G2P_MODEL is None:
            # Hide one-time download/progress noise. Assigned (not
            # setdefault) so a pre-set leaky env cannot re-enable bars.
            try:
                _tf.logging.set_verbosity_error()
            except Exception:  # noqa: BLE001, S110 - logging is best-effort
                pass
            os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
            os.environ["TRANSFORMERS_VERBOSITY"] = "error"
            os.environ["TRANSFORMERS_NO_ADVISORY_WARNINGS"] = "1"
            # Official Homo-GE2PE recipe: plain from_pretrained, no config
            # tweaks. Forcing tie_word_embeddings=False leaves lm_head
            # randomly initialized (the checkpoint stores one tied copy),
            # so the G2P emits garbage or nothing -- noise audio and
            # "Text prompt cannot be empty". The one-time tied-weights
            # warning that plain loading prints is harmless.
            _G2P_TOK = AutoTokenizer.from_pretrained(POCKET_G2P_REPO)
            _G2P_MODEL = T5ForConditionalGeneration.from_pretrained(POCKET_G2P_REPO)
        _G2P_MODEL.eval()
    tok = _G2P_TOK
    g2p = _G2P_MODEL
    # Minimal normalization when normalize_fa.py is absent.
    norm_text = (text or "").strip().replace("؟", "").replace("?", "")
    try:
        local_norm = pocket_model_dir() / "normalize_fa.py"
        if not local_norm.is_file():
            candidates = list(Path(local_tts_dir()).rglob("normalize_fa.py"))
            if candidates:
                local_norm = candidates[0]
        if local_norm.is_file():
            import importlib.util as _ilu

            spec = _ilu.spec_from_file_location("local_normalize_fa", str(local_norm))
            if spec and spec.loader:
                mod = _ilu.module_from_spec(spec)
                spec.loader.exec_module(mod)  # type: ignore[union-attr]
                if hasattr(mod, "normalize_for_model"):
                    norm_text = mod.normalize_for_model(text)
                    norm_text = norm_text.replace("؟", "").replace("?", "")
    except Exception as exc:  # noqa: BLE001 — optional norm script is best-effort
        logger.debug("local TTS normalize script skipped: %s", exc)
    enc = tok(
        [norm_text],
            add_special_tokens=False,
            return_attention_mask=True,
            return_tensors="pt",
        )
    with torch.no_grad():
        # 5 beams + max_length=512 match how Homo-GE2PE was trained (its
        # model card); greedy decoding garbles the phonemes. early_stopping
        # ends generation as soon as every beam finishes, so a healthy
        # model stays fast -- the old "minutes per click" was the broken
        # lm_head never emitting EOS, not the beam count.
        out = g2p.generate(
            **enc, num_beams=5, min_length=1, max_length=512, early_stopping=True
        )
    raw = tok.batch_decode(out, skip_special_tokens=True)[0].strip()
    table = str.maketrans({"/": "a", "a": "A", "@": "?", "$": "S", "c": "C"})
    return raw.translate(table).replace("1", "")


def _load_pocket_model():
    """Load and cache the pocket v2 model (lazy import)."""
    global _POCKET_MODEL
    if _POCKET_MODEL is not None:
        return _POCKET_MODEL
    try:
        from pocket_tts import TTSModel
    except ImportError as exc:
        from fastapi import HTTPException

        raise HTTPException(
            status_code=400,
            detail=(
                "pocket-tts engine is not installed, so local TTS is unavailable "
                "(model files are downloaded, but the engine package is missing). "
                'Install it with: uv add "pocket-tts @ git+https://github.com/mallahyari/pocket-tts@main" '
                "then restart the app."
            ),
        ) from exc
    # Search primary + legacy roots so a snapshot downloaded under a
    # different data-root is still found after a restart/move.
    cfg_candidates: list[Path] = []
    for base in _candidate_local_tts_dirs():
        direct = base / "models--mehdi-hf--pocket-tts-farsi-v2" / "model.yaml"
        cfg_candidates.append(direct)
        try:
            if base.is_dir():
                cfg_candidates.extend(sorted(base.rglob("model.yaml")))
        except OSError:
            continue
    # Fallback: pre-layout snapshot directly under the shared data-root
    # models dir (no broad rglob here: the shared dir also holds whisper +
    # embeddings, and a full recursive scan blocks TTS for a long time).
    try:
        shared_snap = _shared_pocket_snapshot()
        if shared_snap is not None:
            cfg_candidates.append(shared_snap / "model.yaml")
    except Exception:  # noqa: BLE001, S110 - fallback scan is best-effort
        pass
    # Prefer a config whose sibling looks like the pocket v2 snapshot.
    def _is_pocket_cfg(p: Path) -> bool:
        try:
            parent = p.parent
            return (parent / "model.safetensors").is_file() and (
                parent / "tokenizer_ph.model"
            ).is_file()
        except OSError:
            return False
    pocket_cfgs = [p for p in cfg_candidates if p.is_file() and _is_pocket_cfg(p)]
    rest = [p for p in cfg_candidates if p.is_file() and p not in pocket_cfgs]
    ordered = pocket_cfgs + rest
    cfg = str(ordered[0]) if ordered else None
    if cfg is None:
        # Never fall back to the bundled English default: that would download
        # English weights on first click (slow) and speak Persian wrong.
        # Fail fast with a clear download hint instead.
        from fastapi import HTTPException

        raise HTTPException(
            status_code=400,
            detail=(
                f"local TTS model '{POCKET_REPO}' is not downloaded. "
                "Download it in Settings → Models → Text to Speech."
            ),
        )
    with _MODEL_LOCK:
        if _POCKET_MODEL is not None:
            return _POCKET_MODEL
        # Quantized CPU inference is faster with no quality loss (per
        # pocket-tts docs) so the first click answers sooner. torchao is
        # optional: fall back to full precision when it is missing so local
        # TTS never breaks entirely because of the speed flag.
        try:
            _POCKET_MODEL = TTSModel.load_model(config=cfg, quantize=True)  # type: ignore[call-arg]
        except Exception:
            logger.debug("quantized pocket load failed, retrying full precision", exc_info=True)
            _POCKET_MODEL = TTSModel.load_model(config=cfg)  # type: ignore[call-arg]
        return _POCKET_MODEL


def _voice_state(model, voice_id: str):
    """Return cached voice state for the default (or custom wav) prompt."""
    global _POCKET_VOICE_STATE, _POCKET_VOICE_KEY
    prompt = default_prompt_path()
    vid = (voice_id or "").strip() or POCKET_DEFAULT_VOICE
    # Custom wav path wins when it exists.
    custom = Path(vid)
    if custom.is_file():
        prompt = str(custom)
        vid = str(custom)
    else:
        # Self-heal a missing prompt (fresh download, moved data-root) so
        # synthesis never fails with FileNotFound after weights are ready.
        try:
            healed = _ensure_default_prompt([*_pocket_model_dirs()])
            if healed is not None:
                prompt = str(healed)
        except OSError:
            pass
    if _POCKET_VOICE_STATE is not None and _POCKET_VOICE_KEY == vid:
        return _POCKET_VOICE_STATE
    # Keep prompt <=5s per v2 requirement; get_state handles trimming via voice-sec.
    _POCKET_VOICE_STATE = model.get_state_for_audio_prompt(prompt)
    _POCKET_VOICE_KEY = vid
    return _POCKET_VOICE_STATE


def _pocket_tokenizer(model):
    """Return the pocket SentencePiece tokenizer, or None when unavailable."""
    try:
        return model.flow_lm.conditioner.tokenizer
    except Exception:  # noqa: BLE001 - attribute layout may change across versions
        return None


def _split_phoneme_chunks(model, phonemes: str) -> list[str]:
    """Split phonemes into chunks within the safe token ceiling.

    The G2P output carries no punctuation, so pocket's internal sentence
    splitter cannot break it up: it emits ONE oversized chunk and silently
    skips every word beyond POCKET_MAX_CHUNK_TOKENS (speech that stops
    mid-sentence). Worse, the phoneme glottal-stop "?" shares a token id
    with the "?" sentence-boundary token, so pocket's splitter cuts
    inside words ("vAqe?i" -> "vAqe? i") and re-inflates our chunks
    past the ceiling (17 -> 20 tokens). Pre-split on word boundaries
    with the model's own tokenizer and bypass pocket's splitter via
    _generate_chunk_audio so every word is spoken verbatim.
    """
    words = [w for w in (phonemes or "").split() if w]
    if not words:
        return []
    tok = _pocket_tokenizer(model)

    def _count(text: str) -> int:
        if tok is not None:
            try:
                return len(tok(text)[0].tolist())
            except Exception as exc:  # noqa: BLE001 - fall through to the approximation
                logger.debug("pocket tokenizer count failed: %s", exc)
        # ~3 phoneme chars per token as a rough fallback.
        return (len(text) + 2) // 3

    chunks: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and _count(candidate) > POCKET_SPLIT_BUDGET_TOKENS:
            chunks.append(current)
            current = word
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def _concat_audio(parts: list, crossfade_samples: int = 480, gap_samples: int = 0):
    """Join generated chunk tensors/arrays along the sample axis.

    Chunks are synthesized independently, so a hard join leaves a click or
    a short pause at every word boundary. Blend a short overlap (~20 ms at
    24 kHz) with a linear crossfade so joins sound continuous.

    gap_samples inserts a short silence between top-level chunks so they
    breathe instead of sounding rushed (back-to-back chunks with no pause
    sound sped up, as if the playback rate went up). Keep it 0 when
    joining frames of a single generation.

    crossfade_samples must stay 0 for CONTIGUOUS frames of one streaming
    generation: those frames are consecutive slices of the same audio and
    pocket itself joins them with a plain torch.cat. Crossfading them
    DELETES fade samples at every frame joint (~25% of each ~80 ms frame
    at 480 samples), compressing the timeline ~20% — speech sounds as if
    the playback rate went up. Only independently synthesized chunks get
    the crossfade.
    """
    import numpy as np

    try:
        import torch

        arrays = [
            p.detach().cpu().numpy().reshape(-1)
            if isinstance(p, torch.Tensor)
            else np.asarray(p).reshape(-1)
            for p in parts
        ]
    except ImportError:
        arrays = [np.asarray(p).reshape(-1) for p in parts]
    if len(arrays) == 1:
        return parts[0]
    if gap_samples and len(arrays) > 1:
        gap = np.zeros(max(0, int(gap_samples)), dtype=np.float32)
        seq: list = []
        for i, arr_item in enumerate(arrays):
            if i:
                seq.append(gap)
            seq.append(arr_item)
        arrays = seq
    fade = max(0, int(crossfade_samples))
    out = arrays[0]
    for nxt in arrays[1:]:
        if fade > 0 and len(out) > fade and len(nxt) > fade:
            ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
            head = out[:-fade]
            tail = (
                out[-fade:].astype(np.float32) * (1.0 - ramp)
                + nxt[:fade].astype(np.float32) * ramp
            )
            out = np.concatenate([head, tail, nxt[fade:]])
        else:
            out = np.concatenate([out, nxt])
    return out


def _generate_chunk_audio(model, voice_state, chunk: str):
    """Generate audio for one pre-split phoneme chunk.

    Bypasses pocket's split_into_best_sentences (called inside
    generate_audio): its sentence-boundary tokens collide with the phoneme
    glottal-stop "?", so it cuts inside words and re-inflates chunks
    past the token ceiling (speech that stutters mid-sentence). The
    short-text stream path takes the chunk verbatim with no re-splitting.
    Falls back to generate_audio for model doubles without the private
    short-text entry point (unit tests).
    """
    short = getattr(model, "_generate_audio_stream_short_text", None)
    if short is None:
        return model.generate_audio(
            voice_state, chunk, max_tokens=POCKET_MAX_CHUNK_TOKENS
        )
    frames = getattr(model, "model_recommended_frames_after_eos", None)
    if frames is None:
        frames = 3
    pieces = list(
        short(
            model_state=voice_state,
            text_to_generate=chunk,
            frames_after_eos=frames,
            copy_state=True,
        )
    )
    # Contiguous frames of ONE generation: pocket joins these with a bare
    # torch.cat. Any crossfade here deletes samples at every joint and
    # compresses the timeline (~20% at 480 samples per ~80 ms frame),
    # which is exactly the "sounds sped up" bug. Hard-join instead.
    return _concat_audio(pieces, crossfade_samples=0)


def synthesize_wav(text: str, voice_id: str = "") -> bytes:
    """Synthesize WAV bytes with pocket-tts-farsi-v2 (lazy imports)."""
    import io
    import wave

    started = time.monotonic()
    cleaned = (text or "").strip()
    if not cleaned:
        from fastapi import HTTPException

        raise HTTPException(status_code=400, detail="missing 'text' field")
    vid = (voice_id or "").strip() or POCKET_DEFAULT_VOICE
    print(f"[local-tts] synth start chars={len(cleaned)} voice={vid}", flush=True)
    _tts_touch()
    logger.warning("local TTS request: %d chars voice=%s", len(cleaned), vid)
    if not is_pocket_ready():
        from fastapi import HTTPException

        try:
            _dbg_dir = str(_primary_local_tts_dir())
            _dbg_size = 0
            try:
                for _p in _primary_local_tts_dir().rglob("*"):
                    try:
                        if _p.is_file():
                            _dbg_size += _p.stat().st_size
                    except OSError:
                        continue
            except OSError:
                pass
        except Exception:  # noqa: BLE001 - diagnostic probe is best-effort
            _dbg_dir, _dbg_size = "?", 0
        print(f"[local-tts] not ready dir={_dbg_dir} size={_dbg_size}", flush=True)
        logger.warning("local TTS not ready dir=%s size=%d", _dbg_dir, _dbg_size)
        raise HTTPException(
            status_code=400,
            detail=(
                f"local TTS model '{POCKET_REPO}' is not downloaded. "
                "Download it in Settings → Models → Text to Speech."
            ),
        )
    # A cancelled download aborts synthesis; a paused download must NOT
    # block the speaker icon (download pause is unrelated to playback).
    if _RUNTIME.get("cancel"):
        from fastapi import HTTPException

        raise HTTPException(status_code=400, detail="local TTS cancelled")
    try:
        # The frontend prefetches sentences in parallel, but pocket's
        # generate_audio is NOT thread-safe: overlapping calls corrupt the
        # shared model state and generation hangs without EOS ("Maximum
        # generation length reached without EOS" -> speech stops
        # mid-sentence). Serialize the whole synthesis per process.
        with _SYNTH_LOCK:
            t0 = time.monotonic()
            phonemes = _phonemise_fa(cleaned)
            print(f"[local-tts] g2p done in {time.monotonic() - t0:.1f}s phonemes={len(phonemes)}", flush=True)
            if not phonemes.strip():
                # Empty G2P output would reach pocket as "" and surface as its
                # cryptic "Text prompt cannot be empty"; fail with a clear cause.
                from fastapi import HTTPException

                raise HTTPException(
                    status_code=500,
                    detail="local TTS G2P returned no phonemes for this text",
                )
            t0 = time.monotonic()
            model = _load_pocket_model()
            print(f"[local-tts] model ready in {time.monotonic() - t0:.1f}s", flush=True)
            t0 = time.monotonic()
            voice_state = _voice_state(model, voice_id or POCKET_DEFAULT_VOICE)
            print(f"[local-tts] voice ready in {time.monotonic() - t0:.1f}s", flush=True)
            t0 = time.monotonic()
            chunks = _split_phoneme_chunks(model, phonemes)
            print(f"[local-tts] {len(chunks)} chunk(s) <= {POCKET_SPLIT_BUDGET_TOKENS} tokens", flush=True)
            parts = [
                _generate_chunk_audio(model, voice_state, chunk)
                for chunk in chunks
            ]
            # Natural pacing: independently synthesized chunks joined with no
            # pause sound rushed, as if the playback rate went up. A short
            # silence (~120 ms) between chunks restores normal rhythm.
            # Frames of a single generation join seamlessly inside
            # _generate_chunk_audio (gap 0), so only chunk joints breathe.
            rate = int(getattr(model, "sample_rate", 24000) or 24000)
            audio = _concat_audio(parts, gap_samples=int(rate * 0.12))
            print(f"[local-tts] generate done in {time.monotonic() - t0:.1f}s", flush=True)
        try:
            import numpy as _np

            data = audio.detach().cpu().numpy() if hasattr(audio, "detach") else _np.asarray(audio)
        except Exception:  # noqa: BLE001 — tensor conversion fallback
            data = audio
        import numpy as np

        arr = np.asarray(data, dtype=np.float32).reshape(-1)
        arr = np.clip(arr, -1.0, 1.0)
        pcm = (arr * 32767.0).astype(np.int16).tobytes()
        with io.BytesIO() as buf:
            with wave.open(buf, "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(rate)
                wav_file.writeframes(pcm)
            return buf.getvalue()
    except Exception as exc:
        from fastapi import HTTPException

        print(f"[local-tts] synth failed after {time.monotonic() - started:.1f}s: {exc}", flush=True)
        logger.warning("local TTS failed after %.1fs: %s", time.monotonic() - started, exc)
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=500, detail=f"local speech synthesis failed: {exc}") from exc


def warmup_local_tts() -> bool:
    """Preload G2P + pocket model + voice state once (background, best-effort)."""
    try:
        if not is_pocket_ready():
            print("[local-tts] warmup skipped (model not downloaded)", flush=True)
            return False
        t0 = time.monotonic()
        print("[local-tts] warmup start", flush=True)
        logger.warning("local TTS warmup start")
        # Warm G2P first so the first real request never pays the T5
        # download + weight-load cost inside the user-visible timeout.
        try:
            _phonemise_fa("سلام")
            print(f"[local-tts] warmup g2p done in {time.monotonic() - t0:.1f}s", flush=True)
        except Exception as exc:  # noqa: BLE001 - G2P warmup is best-effort
            print(f"[local-tts] warmup g2p failed: {exc}", flush=True)
        model = _load_pocket_model()
        _voice_state(model, POCKET_DEFAULT_VOICE)
        _tts_touch()
        print(f"[local-tts] warmup done in {time.monotonic() - t0:.1f}s", flush=True)
        logger.warning("local TTS warmup done in %.1fs", time.monotonic() - t0)
        return True
    except Exception as exc:  # noqa: BLE001 - warmup must never crash startup
        print(f"[local-tts] warmup failed: {exc}", flush=True)
        logger.debug("local TTS warmup failed: %s", exc)
        return False
