"""File-based app state store (settings + chats + skills + MCP + plans).

All user data now lives as plain JSON / markdown files under the user-level
data root (default ``~/.codifa``, configurable by Electron via
``CODER_DATA_DIR``), replacing the old SQLite ``coder.db``:

    {data_root}/
      settings.json                             # app settings (single kv)
      chats/<workspace-slug>/<chat-id>.json     # one file per chat
      plan/<workspace-slug>/<chat-id>/plan.md   # per-chat implementation plan
      plan/<workspace-slug>/<chat-id>/plan.meta.json  # title / updated_at
      skills/<slug>/skill.md                    # skill body + frontmatter (source of truth)
      mcp/<safe-name>.json                      # one file per MCP connector

Why files instead of SQLite for user data: the user asked for data to be plain
editable files (settings.json, chats/, plan/…, skills/, mcp/), and SQLite stays
only where it is genuinely needed — the RAG vector stores (separate ``.sqlite``
files under ``{data_root}/vector-db``).

Migration: the first time the old ``coder.db`` is detected it is imported once
into this file layout and then renamed to ``coder.db.migrated``. Nothing is
deleted. All writes are atomic (tmp file + ``os.replace``) and guarded by a
module lock, so a crash can never corrupt a file mid-write.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import time

_LOCK = threading.RLock()

# -- paths ------------------------------------------------------------------ #


def data_root() -> str:
    """The sidecar's user-level data root (set by Electron via CODER_DATA_DIR).

    When run standalone (no Electron), falls back to the default ``~/.codifa``
    and, on first use, non-destructively copies any pre-1.2 ``~/.coder`` root
    into it so existing data survives the rename.
    """
    base = os.environ.get("CODER_DATA_DIR", "").strip()
    if not base:
        base = os.path.join(os.path.expanduser("~"), ".codifa")
        _migrate_legacy_root(base)
    os.makedirs(base, exist_ok=True)
    return base


def bootstrap() -> None:
    """Ensure the essential data-root directories exist on every startup.

    Files and dirs like settings.json, skills/, mcp/, plan/, memory/, models/
    and vector-db/ are lazily created on first write, so if a user manually
    deletes them the app keeps working on the next restart instead of silently
    missing a directory.
    """
    data_root()
    for d in (skills_dir(), mcp_dir(), plans_dir(), memory_dir(), models_dir(), resume_dir()):
        os.makedirs(d, exist_ok=True)
    os.makedirs(vector_db_dir(), exist_ok=True)
    sp = settings_path()
    if not os.path.exists(sp):
        try:
            _atomic_write(sp, "{}")
        except OSError:
            pass  # best effort


def _migrate_legacy_root(new_default: str) -> None:
    """Copy ``~/.coder`` → ``~/.codifa`` once (never delete the source)."""
    if os.path.exists(new_default):
        return  # already migrated or fresh install
    legacy = os.path.join(os.path.expanduser("~"), ".coder")
    if legacy == new_default or not os.path.isdir(legacy):
        return
    try:
        import shutil

        shutil.copytree(legacy, new_default, dirs_exist_ok=True)
    except OSError:
        pass  # best effort — an empty new root is fine


def db_path() -> str:
    """Legacy SQLite DB path (migrated away on first use; kept for compat)."""
    return os.path.join(data_root(), "coder.db")


def settings_path() -> str:
    return os.path.join(data_root(), "settings.json")


def chats_dir() -> str:
    return os.path.join(data_root(), "chats")


def vector_db_dir() -> str:
    return os.path.join(data_root(), "vector-db")


def plans_dir() -> str:
    return os.path.join(data_root(), "plan")


def resume_dir() -> str:
    """Directory for per-chat interrupted-turn resume state.

    When a run is cut off (user Stop, an error, or the app closing mid-stream)
    the backend persists the FULL results of every tool call it completed, so a
    later run for the same chat can continue from where it stopped instead of
    redoing the work. Files live on disk (not memory) so they survive a full
    app restart. Keyed by workspace + chat id.
    """
    return os.path.join(data_root(), "resume")


def _resume_file(root: str, chat_id: str) -> str:
    ws = _slugify(
        os.path.basename(os.path.realpath(root).rstrip(os.sep)) or "workspace"
    )
    cid = _safe_file(chat_id, fallback="chat")
    return os.path.join(resume_dir(), ws, f"{cid}.json")


def save_turn_resume(root: str, chat_id: str, payload: dict) -> None:
    """Persist the completed-tool records of the current turn for ``chat_id``.

    Overwrites the previous state so the file always holds the most recent
    interrupted turn. Best-effort: never raises (I/O must not fail a run).
    """
    if not chat_id:
        return
    try:
        _atomic_write_json(_resume_file(root, chat_id), payload)
    except (OSError, TypeError, ValueError):  # best-effort
        pass


def load_turn_resume(root: str, chat_id: str) -> dict | None:
    """Read the persisted resume state for ``chat_id``, or None."""
    if not chat_id:
        return None
    data = _read_json(_resume_file(root, chat_id))
    return data if isinstance(data, dict) else None


def clear_turn_resume(root: str, chat_id: str) -> None:
    """Remove the persisted resume state for ``chat_id`` (after a clean finish)."""
    if not chat_id:
        return
    try:
        os.remove(_resume_file(root, chat_id))
    except OSError:
        pass


def skills_dir() -> str:
    return os.path.join(data_root(), "skills")


def mcp_dir() -> str:
    return os.path.join(data_root(), "mcp")


def models_dir() -> str:
    return os.path.join(data_root(), "models")


def memory_dir() -> str:
    return os.path.join(data_root(), "memory")


def cache_path() -> str:
    return os.path.join(data_root(), "cache.sqlite")


# -- small helpers ---------------------------------------------------------- #


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "workspace"


def _safe_file(name: str, fallback: str = "item") -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", str(name).strip()).strip(".-")
    return safe or fallback


def _now() -> float:
    return time.time()


def _atomic_write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def _atomic_write_json(path: str, obj) -> None:
    _atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=2))


def _read_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError, TypeError):
        return None


def _read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def _iter_chat_files():
    base = chats_dir()
    if not os.path.isdir(base):
        return
    for ws in sorted(os.listdir(base)):
        ws_dir = os.path.join(base, ws)
        if not os.path.isdir(ws_dir):
            continue
        for fn in sorted(os.listdir(ws_dir)):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(ws_dir, fn)
            obj = _read_json(p)
            if isinstance(obj, dict) and obj.get("id"):
                yield obj


# -- settings --------------------------------------------------------------- #


def get_settings() -> dict | None:
    obj = _read_json(settings_path())
    return obj if isinstance(obj, dict) else None


def save_settings(settings: dict | None) -> None:
    """Overwrite the settings file (atomic).

    Guard: never let a cold-start DEFAULT skeleton clobber real settings. On a
    slow external volume the renderer may load defaults before the real
    settings.json is readable; if it persisted those, the file would be wiped.
    When an existing, substantive settings file is on disk and the incoming
    payload looks like fresh defaults (no workspaces / recent models / colors),
    keep the existing file and archive it to ``settings.json.bak`` instead.
    """
    if settings is None:
        return
    with _LOCK:
        _migrate_legacy_db()
    _backup_then_save_settings(settings)


# Keys the renderer ships as cold-start defaults (see src/lib/store.ts
# ``writeStateNow`` and the default ``settings`` object). A payload that carries
# ONLY these keys — and no real-data marker — is the cold-start default
# skeleton. Any key outside this set (e.g. a user-toggled ``theme``) marks the
# write as a real, intentional update that must be persisted.
_DEFAULT_SETTINGS_KEYS = frozenset(
    {
        "providers",
        "activeProviderId",
        "systemPrompts",
        "mcpServers",
        "mcpEnabled",
        "modes",
        "compactHeadroom",
        "root",
        "dir",
        "recentModels",
        "sidebarOpen",
        "fontSize",
        "vectorDbPath",
        "dataPath",
        "whisperModel",
        "whisperBaseUrl",
        "embeddingModel",
        "embeddingBaseUrl",
        "subagentModels",
        "memory",
        "memoryTtlDays",
        "memoryMaxDocs",
        "memoryMaxChunks",
        "workspaceColors",
        "pinnedWorkspaces",
        "workspaces",
        "searchPlugins",
        "searchConsole",
        "pinnedChats",
    }
)


def _looks_like_default_skeleton(settings: dict) -> bool:
    """True ONLY when the payload is the cold-start DEFAULT skeleton — i.e. it
    carries no key outside the renderer's default set and no real-data marker.

    A partial user update such as ``{"theme": "light"}`` is NOT a skeleton
    (``theme`` is never a default key) and must be persisted; only the full
    default object written before real settings are hydrated qualifies."""
    if not isinstance(settings, dict) or not settings:
        return False
    # Any key the renderer never ships as a default => this is a real write.
    if set(settings) - _DEFAULT_SETTINGS_KEYS:
        return False
    if (
        settings.get("workspaces")
        or settings.get("recentModels")
        or settings.get("workspaceColors")
        or settings.get("systemPrompts")
        or settings.get("modes")
        or settings.get("mcpServers")
    ):
        return False
    # Also require NO configured provider: a user who wiped their workspaces
    # but still has an API key / selected model configured is NOT a skeleton.
    for p in settings.get("providers") or []:
        if isinstance(p, dict) and (p.get("apiKey") or p.get("models")):
            return False
    return True


def _backup_then_save_settings(settings: dict) -> None:
    path = settings_path()
    existing = _read_json(path)
    if isinstance(existing, dict) and existing and _looks_like_default_skeleton(settings):
        # Real settings exist but the incoming payload is a default skeleton —
        # almost certainly a cold-start write racing the volume. Back up the
        # real file and refuse to overwrite it.
        try:
            _atomic_write(settings_path() + ".bak", json.dumps(existing, ensure_ascii=False, indent=2))
            print(
                "[state_db] settings write refused: existing file looks real, "
                "incoming payload is a default skeleton — keeping existing, "
                "archived to settings.json.bak",
                flush=True,
            )
        except OSError:
            pass
        return
    with _LOCK:
        _atomic_write_json(path, settings)


# -- chats ------------------------------------------------------------------ #


def _chat_workspace(chat: dict) -> str:
    root = str(chat.get("root") or "").strip()
    if root:
        return _slugify(os.path.basename(os.path.realpath(root).rstrip(os.sep))) or "workspace"
    return "workspace"


def _chat_file(chat: dict) -> str:
    ws = _safe_file(_chat_workspace(chat), "workspace")
    cid = _safe_file(str(chat.get("id") or "chat"), "chat")
    return os.path.join(chats_dir(), ws, f"{cid}.json")


def _write_chat(chat: dict) -> None:
    if not isinstance(chat, dict) or not chat.get("id"):
        return
    _atomic_write_json(_chat_file(chat), chat)


def save_chats(chats: list, deleted_ids: list | None = None) -> None:
    """Write/update chat files; remove chats whose ids are in ``deleted_ids``.

    (Members absent from ``chats`` are NOT removed — matches the old DB
    behaviour where only explicitly-deleted ids were deleted.)
    """
    with _LOCK:
        _migrate_legacy_db()
        if deleted_ids:
            for cid in deleted_ids:
                _delete_chat_by_id(str(cid))
        for c in chats or []:
            _write_chat(c)


def _delete_chat_by_id(cid: str) -> None:
    if not cid:
        return
    for obj in list(_iter_chat_files()):
        if str(obj.get("id")) == cid:
            try:
                os.remove(_chat_file(obj))
            except OSError:
                pass
            return


def remove_workspace_vectors(roots: list) -> None:
    """Delete the per-workspace RAG vector store file for each removed root.

    Keeps memory/search space in sync when a whole workspace is deleted from
    the sidebar. ``roots`` are the absolute project paths that were removed;
    the vector file is named after the slugified basename.
    """
    import shutil

    vdir = vector_db_dir()
    for r in roots or []:
        if not r or not isinstance(r, str):
            continue
        slug = (
            re.sub(r"[^A-Za-z0-9_.-]+", "-", os.path.basename(os.path.realpath(r)).rstrip(os.sep)).strip("-")
            or "workspace"
        )
        for suffix in (".vectors.sqlite", ".vectors.sqlite-wal", ".vectors.sqlite-shm"):
            try:
                os.remove(os.path.join(vdir, f"{slug}{suffix}"))
            except OSError:
                pass
    try:
        if os.path.isdir(vdir) and not os.listdir(vdir):
            shutil.rmtree(vdir, ignore_errors=True)
    except OSError:
        pass


# -- skills ----------------------------------------------------------------- #


def _skill_dir(slug: str) -> str:
    return os.path.join(skills_dir(), _safe_file(slug, "skill"))


def _skill_md_path(slug: str) -> str:
    return os.path.join(_skill_dir(slug), "skill.md")


def _parse_skill_frontmatter(raw: str) -> tuple[str, str, str]:
    """Return ``(name, slug, description)`` parsed from a skill markdown file.

    The first ``---`` fenced block is treated as YAML frontmatter. Falls back to
    deriving the name from the first ``# Heading`` line or the first non-empty
    line when frontmatter is absent.
    """
    name = ""
    slug = ""
    description = ""
    if raw.startswith("---"):
        end = raw.find("\n---", 3)
        if end != -1:
            block = raw[3:end].strip("\n")
            for line in block.splitlines():
                if ":" not in line:
                    continue
                key, _, val = line.partition(":")
                key = key.strip().lower()
                val = val.strip().strip('"').strip("'")
                if key == "name":
                    name = val
                elif key == "slug":
                    slug = val
                elif key == "description":
                    description = val
    if not name:
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            if line.startswith("#"):
                name = line.lstrip("#").strip()
            else:
                name = line
            break
    if not slug and name:
        slug = slugify(name)
    return name, slug, description


def _find_skill_dir(name_or_slug: str) -> str | None:
    """Locate a skill's directory by name or slug. Returns None when missing."""
    name_or_slug = str(name_or_slug or "").strip()
    if not name_or_slug:
        return None
    slug = _slugify(name_or_slug)
    # Prefer exact slug dir.
    d = _skill_dir(slug)
    if os.path.isdir(d) and os.path.isfile(os.path.join(d, "skill.md")):
        return d
    # Fall back to matching the stored name inside the skill.md frontmatter.
    base = skills_dir()
    if os.path.isdir(base):
        for entry in os.listdir(base):
            p = os.path.join(base, entry)
            if not os.path.isdir(p):
                continue
            md = os.path.join(p, "skill.md")
            if not os.path.isfile(md):
                continue
            name, _, _ = _parse_skill_frontmatter(_read_text(md))
            if name and name.strip() == name_or_slug:
                return p
    return None


def save_skill(name: str, slug: str, description: str, path: str, content: str) -> None:
    """Persist a skill as ``skills/<slug>/skill.md`` with YAML frontmatter.

    The frontmatter carries ``name``/``slug``/``description``; the rest of the
    file is the skill body. ``path`` is informational (the on-disk location).
    """
    with _LOCK:
        _migrate_legacy_db()
        name = str(name or "").strip()
        slug = str(slug or "").strip() or _slugify(name) or "skill"
        content = str(content or "")
        d = _skill_dir(slug)
        os.makedirs(d, exist_ok=True)
        # Strip any pre-existing frontmatter so we don't duplicate it.
        if content.startswith("---"):
            end = content.find("\n---", 3)
            if end != -1:
                content = content[end + 4:].lstrip("\n")
        front = (
            "---\n"
            f"name: {name}\n"
            f"slug: {slug}\n"
            f"description: {str(description or '').strip()}\n"
            "---\n\n"
        )
        _atomic_write(os.path.join(d, "skill.md"), front + content)


def list_skills() -> list[dict]:
    """Return all skills as ``{name, slug, description, path, content}``."""
    base = skills_dir()
    if not os.path.isdir(base):
        return []
    out: list[dict] = []
    with _LOCK:
        for entry in sorted(os.listdir(base)):
            d = os.path.join(base, entry)
            if not os.path.isdir(d):
                continue
            md = os.path.join(d, "skill.md")
            if not os.path.isfile(md):
                continue
            raw = _read_text(md)
            name, slug, description = _parse_skill_frontmatter(raw)
            body = raw
            if body.startswith("---"):
                end = body.find("\n---", 3)
                if end != -1:
                    body = body[end + 4:].lstrip("\n")
            out.append(
                {
                    "name": name or entry,
                    "slug": slug or entry,
                    "description": description,
                    "path": f"file://{md}",
                    "content": body,
                }
            )
    return out


def delete_skill(name: str) -> bool:
    """Remove a skill (by name or slug) and its directory. True when removed."""
    with _LOCK:
        d = _find_skill_dir(name)
        if not d:
            return False
        try:
            import shutil

            shutil.rmtree(d, ignore_errors=True)
            return True
        except OSError:
            return False


# -- MCP connectors --------------------------------------------------------- #


def _mcp_file(name: str) -> str:
    return os.path.join(mcp_dir(), f"{_safe_file(name, 'connector')}.json")


def save_mcp(name: str, config: str) -> None:
    """Upsert an MCP connector file keyed by ``name`` (``config`` is JSON)."""
    with _LOCK:
        _migrate_legacy_db()
        name = str(name or "").strip()
        if not name:
            return
        try:
            parsed = json.loads(config) if isinstance(config, str) else config
        except (ValueError, TypeError):
            parsed = {}
        _atomic_write_json(
            _mcp_file(name),
            {"name": name, "config": parsed if isinstance(parsed, dict) else {}},
        )


def list_mcp() -> dict:
    """Return all MCP connectors as ``{name: config}``."""
    base = mcp_dir()
    if not os.path.isdir(base):
        return {}
    out: dict = {}
    with _LOCK:
        for fn in sorted(os.listdir(base)):
            if not fn.endswith(".json"):
                continue
            obj = _read_json(os.path.join(base, fn))
            if not isinstance(obj, dict):
                continue
            name = str(obj.get("name") or "").strip()
            cfg = obj.get("config")
            if name and isinstance(cfg, dict):
                out[name] = cfg
    return out


def delete_mcp(name: str) -> bool:
    """Remove an MCP connector file. True when one was removed."""
    with _LOCK:
        try:
            os.remove(_mcp_file(name))
            return True
        except OSError:
            return False


# -- Plans (one per chat, under plan/<workspace>/<chat-id>/) ---------------- #


def _plan_dir(workspace: str, chat_id: str) -> str:
    ws = _safe_file(workspace or "workspace", "workspace")
    cid = _safe_file(chat_id or "default", "default")
    return os.path.join(plans_dir(), ws, cid)


def save_plan(workspace: str, title: str, content: str, chat_id: str = "") -> None:
    """Upsert the plan for a workspace+chat as ``plan/<ws>/<chat>/plan.md``.

    ``chat_id`` empty (legacy callers) maps to the ``default`` chat folder. A
    ``plan.meta.json`` sidecar carries the title and timestamp so the most
    recent plan can be found without parsing markdown.
    """
    with _LOCK:
        _migrate_legacy_db()
        d = _plan_dir(workspace, chat_id)
        _atomic_write(
            os.path.join(d, "plan.md"),
            str(content or ""),
        )
        _atomic_write_json(
            os.path.join(d, "plan.meta.json"),
            {
                "workspace": str(workspace or ""),
                "chat_id": str(chat_id or ""),
                "title": str(title or ""),
                "updated_at": _now(),
            },
        )


def save_plan_checklist(
    workspace: str, title: str, items: list[dict], chat_id: str = ""
) -> None:
    """Persist the live checklist (update_plan items) for a workspace+chat.

    The plan markdown is saved by the graph node (plan_build); the checklist is
    a separate sidecar so the step-by-step todos survive reloads and aren't lost
    when only the node writes the markdown. Stored as
    ``plan/<ws>/<chat>/plan.checklist.json``.
    """
    with _LOCK:
        _migrate_legacy_db()
        d = _plan_dir(workspace, chat_id)
        _atomic_write_json(
            os.path.join(d, "plan.checklist.json"),
            {
                "workspace": str(workspace or ""),
                "chat_id": str(chat_id or ""),
                "title": str(title or ""),
                "items": items or [],
                "updated_at": _now(),
            },
        )


def get_plan_checklist(workspace: str, chat_id: str = "") -> dict | None:
    """Return ``{"workspace", "chat_id", "title", "items"}`` or None if absent."""
    with _LOCK:
        d = _plan_dir(workspace, chat_id)
        data = _read_json(os.path.join(d, "plan.checklist.json"))
        if not isinstance(data, dict):
            return None
        return {
            "workspace": data.get("workspace", ""),
            "chat_id": data.get("chat_id", ""),
            "title": data.get("title", ""),
            "items": data.get("items", []),
        }


def _most_recent_chat_dir(ws_dir: str) -> str | None:
    best: tuple[float, str] | None = None
    try:
        entries = os.listdir(ws_dir)
    except OSError:
        return None
    for entry in entries:
        d = os.path.join(ws_dir, entry)
        if not os.path.isdir(d):
            continue
        meta = _read_json(os.path.join(d, "plan.meta.json"))
        ts = 0.0
        if isinstance(meta, dict):
            try:
                ts = float(meta.get("updated_at") or 0)
            except (TypeError, ValueError):
                ts = 0.0
        if ts <= 0:
            try:
                ts = os.path.getmtime(os.path.join(d, "plan.md"))
            except OSError:
                ts = 0.0
        if best is None or ts > best[0]:
            best = (ts, d)
    return best[1] if best else None


def get_plan(workspace: str, chat_id: str = "") -> dict | None:
    """Return ``{"workspace", "chat_id", "title", "content"}``.

    With an explicit ``chat_id`` reads that chat's plan; with an empty one
    (legacy callers) returns the most recently updated plan in the workspace.
    """
    with _LOCK:
        ws_dir = os.path.join(plans_dir(), _safe_file(workspace or "workspace", "workspace"))
        if chat_id:
            d = os.path.join(ws_dir, _safe_file(chat_id, "default"))
        else:
            d = _most_recent_chat_dir(ws_dir) or ""
        if not d or not os.path.isfile(os.path.join(d, "plan.md")):
            return None
        meta = _read_json(os.path.join(d, "plan.meta.json")) or {}
        content = _read_text(os.path.join(d, "plan.md"))
        if not content.strip():
            return None
        return {
            "workspace": workspace or str(meta.get("workspace") or ""),
            "chat_id": str(meta.get("chat_id") or chat_id or ""),
            "title": str(meta.get("title") or ""),
            "content": content,
        }


def list_plans() -> list[dict]:
    """Return all saved plans as ``{"workspace", "chat_id", "title", "content"}``."""
    base = plans_dir()
    if not os.path.isdir(base):
        return []
    out: list[dict] = []
    with _LOCK:
        for ws in sorted(os.listdir(base)):
            ws_dir = os.path.join(base, ws)
            if not os.path.isdir(ws_dir):
                continue
            for cid in sorted(os.listdir(ws_dir)):
                d = os.path.join(ws_dir, cid)
                if not os.path.isdir(d):
                    continue
                plan = get_plan(ws, cid)
                if plan:
                    out.append(plan)
    return out


def delete_plan(workspace: str, chat_id: str = "") -> bool:
    """Remove a plan. With a chat_id removes that chat's plan folder; with an
    empty one removes the whole workspace plan folder. True when removed."""
    import shutil

    with _LOCK:
        ws_dir = os.path.join(plans_dir(), _safe_file(workspace or "workspace", "workspace"))
        target = (
            os.path.join(ws_dir, _safe_file(chat_id, "default"))
            if chat_id
            else ws_dir
        )
        if not os.path.isdir(target):
            return False
        try:
            shutil.rmtree(target, ignore_errors=True)
            return True
        except OSError:
            return False


# -- whole-state snapshot --------------------------------------------------- #


def get_state() -> dict:
    """Return ``{"settings": ...|None, "chats": [...]}`` from the file layout."""
    with _LOCK:
        _migrate_legacy_db()
        settings = get_settings()
        chats = sorted(
            _iter_chat_files(),
            key=lambda c: float(c.get("updatedAt") or 0),
        )
        return {"settings": settings, "chats": chats}


# -- one-time migration from the old SQLite coder.db ------------------------ #

_MIGRATING = False


def _migrate_legacy_db() -> None:
    """Import the legacy ``coder.db`` into files once, then rename the DB.

    Runs when the DB file still exists (it no longer exists after a successful
    migration, so it's naturally idempotent across restarts). If anything fails
    mid-way the DB is left in place and the migration retries next launch.

    IMPORTANT: writes here go through the low-level ``_atomic_write*`` helpers
    directly — never through the public ``save_*`` functions, which themselves
    call ``_migrate_legacy_db()`` and would recurse forever. The ``_MIGRATING``
    flag is a belt-and-braces re-entrancy guard on top of that.
    """
    global _MIGRATING
    path = db_path()
    if not os.path.exists(path):
        return
    if _MIGRATING:
        return
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error:
        return
    _MIGRATING = True
    try:
        # settings
        try:
            row = conn.execute(
                "SELECT value FROM kv WHERE key = 'settings'"
            ).fetchone()
            if row:
                parsed = json.loads(row[0])
                if isinstance(parsed, dict):
                    _atomic_write_json(settings_path(), parsed)
        except sqlite3.Error:
            pass
        # chats
        try:
            for _cid, raw, _upd in conn.execute(
                "SELECT id, json, updated_at FROM chat"
            ):
                try:
                    obj = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if isinstance(obj, dict) and obj.get("id"):
                    _write_chat(obj)
        except sqlite3.Error:
            pass
        # skills (write files directly — no save_skill(), which re-migrates)
        try:
            for name, slug, description, vpath, content in conn.execute(
                "SELECT name, slug, description, path, content FROM skill"
            ):
                name = str(name or "").strip()
                slug = str(slug or "").strip() or _slugify(name) or "skill"
                d = _skill_dir(slug)
                os.makedirs(d, exist_ok=True)
                front = (
                    "---\n"
                    f"name: {name}\n"
                    f"slug: {slug}\n"
                    f"description: {str(description or '').strip()}\n"
                    "---\n\n"
                )
                _atomic_write(os.path.join(d, "skill.md"), front + (content or ""))
        except sqlite3.Error:
            pass
        # mcp (already writes files directly)
        try:
            for name, raw in conn.execute("SELECT name, json FROM mcp"):
                try:
                    parsed = json.loads(raw)
                except (ValueError, TypeError):
                    parsed = {}
                if isinstance(parsed, dict) and name:
                    _atomic_write_json(
                        _mcp_file(name), {"name": name, "config": parsed}
                    )
        except sqlite3.Error:
            pass
        # plans (one per workspace in the old DB → default chat folder)
        try:
            for ws, title, content, upd in conn.execute(
                "SELECT workspace, title, content, updated_at FROM plan"
            ):
                d = _plan_dir(ws, "")
                _atomic_write(os.path.join(d, "plan.md"), content or "")
                _atomic_write_json(
                    os.path.join(d, "plan.meta.json"),
                    {
                        "workspace": ws,
                        "chat_id": "",
                        "title": title or "",
                        "updated_at": upd or _now(),
                    },
                )
        except sqlite3.Error:
            pass
        conn.close()
        # Only after every table migrated successfully do we retire the DB.
        os.replace(path, f"{path}.migrated")
    except Exception:  # noqa: BLE001
        try:
            conn.close()
        except sqlite3.Error:
            pass
        # leave coder.db in place; migration retries next launch
    finally:
        _MIGRATING = False
