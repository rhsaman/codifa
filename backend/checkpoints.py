"""سیستم Checkpoint/Undo: snapshot از محتوای فایل‌ها قبل از هر write/edit مدل.

هر snapshot یک دایرکتوری زیر ``data_root/checkpoints/<chat_id>/<seq>`` است:
  - ``manifest.json``: متادیتا و لیست فایل‌ها ``[{path, existed, sha256}]``
  - ``blobs/<sha256>``: محتوای قبل از تغییر (dedup بر اساس هش)

snapshotها per-turn تجمیع می‌شوند: اولین write در یک turn یک seq جدید می‌سازد و
بقیه‌ی writeهای همان turn به همان seq اضافه می‌شوند. حالتِ «snapshot باز» از طریق
پارامتر ``open_state`` نگه داشته می‌شود که ``make_tool_callbacks`` به‌ازای هر turn
یک نمونه‌ی تازه‌اش را می‌سازد — پس هر turn خودکار یک seq تازه می‌گیرد.

هیچ تابعی از این ماژول exception بیرون نمی‌دهد؛ checkpoint بهترین‌حالت (best-effort)
است و شکستش هرگز نباید write اصلی مدل را بشکند.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time

import state_db

# حداکثر snapshotهای نگه‌داشته‌شده per-chat (قدیمی‌ها در prune حذف می‌شوند)
DEFAULT_KEEP = 50


def _safe_id(chat_id: str) -> str:
    """chat_id را به نام دایرکتوری امن تبدیل می‌کند."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", str(chat_id or "")) or "chat"


def _base_dir(chat_id: str) -> str:
    return os.path.join(state_db.data_root(), "checkpoints", _safe_id(chat_id))


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def _seq_dir(chat_id: str, seq: int) -> str:
    return os.path.join(_base_dir(chat_id), f"{seq:06d}")


def _manifest_path(chat_id: str, seq: int) -> str:
    return os.path.join(_seq_dir(chat_id, seq), "manifest.json")


def _load_manifest(chat_id: str, seq: int) -> dict | None:
    try:
        with open(_manifest_path(chat_id, seq), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _write_blob(chat_id: str, seq: int, content: str) -> str:
    """محتوا را در blobs/<sha> می‌نویسد (اگر هست، دوباره نمی‌نویسد) و sha را برمی‌گرداند."""
    sha = _sha(content)
    blob = os.path.join(_seq_dir(chat_id, seq), "blobs", sha)
    if not os.path.exists(blob):
        os.makedirs(os.path.dirname(blob), exist_ok=True)
        with open(blob, "w", encoding="utf-8", newline="") as fh:
            fh.write(content)
    return sha


def _next_seq(chat_id: str) -> int:
    """بزرگ‌ترین seq موجود + 1 (اولین snapshot = 1)."""
    base = _base_dir(chat_id)
    try:
        seqs = [int(d) for d in os.listdir(base) if d.isdigit()]
    except OSError:
        return 1
    return (max(seqs) + 1) if seqs else 1


def save_pre_edit(
    chat_id: str,
    root: str,
    path: str,
    old_content: str | None,
    open_state: dict | None = None,
) -> int | None:
    """محتوای قبل از write/edit را در snapshot (بازِ همان turn) ذخیره می‌کند.

    ``old_content = None`` یعنی فایل هنوز وجود نداشته (restore آن فایل را حذف
    می‌کند). ``open_state`` دیکشنریِ per-turn است؛ اگر ``open_state["seq"]`` روی
    یک snapshot باز باشد، فایل به همان اضافه می‌شود وگرنه seq جدیدی ساخته می‌شود.
    در صورت خطا ``None`` برمی‌گردد (هرگز raise نمی‌کند).
    """
    if not chat_id:
        return None
    rel = str(path or "").replace(os.sep, "/").lstrip("/")
    try:
        seq = int((open_state or {}).get("seq") or 0)
        man = _load_manifest(chat_id, seq) if seq > 0 else None
        if man is None:
            # snapshot باز نیست (اولین write این turn) → seq جدید
            seq = _next_seq(chat_id)
            man = {
                "seq": seq,
                "created": time.time(),
                "root": os.path.realpath(root),
                "files": [],
            }
            os.makedirs(os.path.join(_seq_dir(chat_id, seq), "blobs"), exist_ok=True)
        # اگر همین فایل قبلاً در همین snapshot ثبت شده، دوباره ثبت نکن
        if any(f["path"] == rel for f in man["files"]):
            if open_state is not None:
                open_state["seq"] = seq
            return seq
        entry = {"path": rel, "existed": old_content is not None}
        if old_content is not None:
            entry["sha256"] = _write_blob(chat_id, seq, old_content)
        man["files"].append(entry)
        with open(_manifest_path(chat_id, seq), "w", encoding="utf-8") as fh:
            json.dump(man, fh, ensure_ascii=False)
        if open_state is not None:
            open_state["seq"] = seq
        return seq
    except OSError:
        return None


def restore(chat_id: str, seq: int, root: str) -> dict:
    """فایل‌های snapshot را به workspace برمی‌گرداند.

    برای هر فایل ``changed=True`` یعنی محتوای فعلی دیسک با محتوای ثبت‌شده در
    snapshot فرق دارد (یعنی بعد از checkpoint تغییر کرده و restore آن تغییر را
    بازنویسی می‌کند) — فرانت‌اند می‌تواند قبل از تایید هشدار بدهد.
    """
    man = _load_manifest(chat_id, seq)
    if man is None:
        return {"error": f"checkpoint {seq} not found"}
    root_real = os.path.realpath(root)
    restored: list[dict] = []
    errors: list[str] = []
    for f in man.get("files", []):
        rel = str(f.get("path", ""))
        target = os.path.realpath(os.path.join(root, rel))
        # مسیر نباید از root بیرون بزند (snapshot ممکن است از workspace دیگری باشد)
        if not (target == root_real or target.startswith(root_real + os.sep)):
            errors.append(f"{rel}: path escapes workspace root")
            continue
        try:
            if f.get("existed"):
                blob = os.path.join(_seq_dir(chat_id, seq), "blobs", f.get("sha256", ""))
                with open(blob, encoding="utf-8", newline="") as fh:
                    content = fh.read()
                changed = False
                if os.path.exists(target):
                    with open(target, encoding="utf-8", newline="") as fh:
                        changed = _sha(fh.read()) != f.get("sha256")
                os.makedirs(os.path.dirname(target) or root, exist_ok=True)
                with open(target, "w", encoding="utf-8", newline="") as fh:
                    fh.write(content)
                restored.append({"path": rel, "changed": changed})
            else:
                # فایل قبل از write وجود نداشته → restore یعنی حذف
                if os.path.exists(target):
                    os.remove(target)
                restored.append({"path": rel, "changed": False})
        except OSError as exc:
            errors.append(f"{rel}: {exc}")
    out: dict = {"seq": seq, "restored": restored}
    if errors:
        out["errors"] = errors
    return out


def list_checkpoints(chat_id: str) -> list[dict]:
    """snapshotهای یک chat، جدیدترین اول."""
    base = _base_dir(chat_id)
    out: list[dict] = []
    try:
        seqs = sorted((int(d) for d in os.listdir(base) if d.isdigit()), reverse=True)
    except OSError:
        return out
    for seq in seqs:
        man = _load_manifest(chat_id, seq)
        if man is None:
            continue
        out.append(
            {
                "seq": seq,
                "created": man.get("created", 0),
                "paths": [f.get("path", "") for f in man.get("files", [])],
            }
        )
    return out


def prune(chat_id: str, keep: int = DEFAULT_KEEP) -> None:
    """قدیمی‌ترین snapshotها را حذف می‌کند تا حداکثر ``keep`` تا بماند."""
    base = _base_dir(chat_id)
    try:
        seqs = sorted(int(d) for d in os.listdir(base) if d.isdigit())
    except OSError:
        return
    for seq in seqs[: max(0, len(seqs) - keep)]:
        import shutil

        shutil.rmtree(os.path.join(base, f"{seq:06d}"), ignore_errors=True)


def delete_chat_checkpoints(chat_id: str) -> None:
    """حذف کامل snapshotهای یک chat (وقتی خود chat حذف می‌شود)."""
    import shutil

    shutil.rmtree(_base_dir(chat_id), ignore_errors=True)
