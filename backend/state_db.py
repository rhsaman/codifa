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
    for d in (skills_dir(), mcp_dir(), plans_dir(), models_dir(), schedules_dir(), schedule_runs_dir()):
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


def skills_dir() -> str:
    return os.path.join(data_root(), "skills")


def mcp_dir() -> str:
    return os.path.join(data_root(), "mcp")


def schedules_dir() -> str:
    return os.path.join(data_root(), "schedules")


def schedule_runs_dir() -> str:
    return os.path.join(schedules_dir(), "runs")


def models_dir() -> str:
    return os.path.join(data_root(), "models")


def memory_dir() -> str:
    """Legacy agent-memory directory (removed feature).

    Kept only so existing installs can migrate their old ``memory/`` folder
    out of the data root via :func:`migrate_memory_dir`. New installs no
    longer create this directory.
    """
    return os.path.join(data_root(), "memory")


def migrate_memory_dir(target_root: str) -> bool:
    """Move any legacy ``memory/`` folder into ``target_root`` (best-effort).

    Returns True if a migration happened. The source is removed after a
    successful move so the data root stays clean. Never raises.
    """
    try:
        src = memory_dir()
        if not os.path.isdir(src):
            return False
        dst = os.path.join(target_root, "memory")
        if os.path.abspath(src) == os.path.abspath(dst):
            return False
        os.makedirs(target_root, exist_ok=True)
        import shutil

        shutil.move(src, dst)
        return True
    except (OSError, ValueError):
        return False


def cache_path() -> str:
    return os.path.join(data_root(), "cache.sqlite")


# -- small helpers ---------------------------------------------------------- #


def _raw_slug(name: str) -> str:
    """Slugify without any fallback ("" when no ASCII letters/digits remain)."""
    return re.sub(r"[^a-z0-9]+", "-", str(name).strip().lower()).strip("-")


def _slugify(name: str) -> str:
    return _raw_slug(name) or "workspace"


def _skill_slug(name: str) -> str:
    """Storage slug for a skill name: the slugified name, or a stable hash
    when it has no ASCII letters (e.g. a Persian name).

    The hash keeps two different non-ASCII names from collapsing into the
    same shared ``skills/skill/`` folder (which silently overwrote earlier
    skills). The normal create path rejects non-English names outright; this
    is the safety net for direct callers and the legacy-DB migration."""
    slug = _raw_slug(name)
    if slug:
        return slug
    digest = hashlib.sha1(str(name).strip().encode("utf-8")).hexdigest()[:8]
    return f"skill-{digest}"


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
    """Yield every chat object on disk, de-duplicated by ``id``.

    Two chat files can share an ``id`` (e.g. an orphaned copy left behind by a
    failed rename or a partial write). Without de-duplication both would load
    into the UI, and two sidebar rows with the same ``id`` make the 3-dot menu
    open for BOTH rows. When a duplicate ``id`` is seen, the file with the
    newer ``updatedAt`` (falling back to the latest filesystem mtime) wins.
    """
    base = chats_dir()
    if not os.path.isdir(base):
        return
    best: dict[str, dict] = {}
    for ws in sorted(os.listdir(base)):
        ws_dir = os.path.join(base, ws)
        if not os.path.isdir(ws_dir):
            continue
        for fn in sorted(os.listdir(ws_dir)):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(ws_dir, fn)
            obj = _read_json(p)
            if not isinstance(obj, dict):
                continue
            cid = obj.get("id")
            if not cid:
                continue
            try:
                mtime = os.path.getmtime(p)
            except OSError:
                mtime = 0.0
            updated = float(obj.get("updatedAt") or 0) or mtime
            existing = best.get(cid)
            if existing is None or updated >= existing["_updated"]:
                best[cid] = {**obj, "_updated": updated}
    for obj in best.values():
        obj.pop("_updated", None)
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
        "sttProviderId",
        "sttModel",
        "embeddingModel",
        "embeddingBaseUrl",
        "ragWebTtlDays",
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


def workspace_slug_for_root(root: str) -> str:
    """Unique workspace slug for a project root.

    Basename plus an 8-char sha1 of the resolved absolute path, so two
    workspaces with the same folder name never share chats, plans, or vectors.
    """
    real = os.path.realpath(str(root or "").strip()).rstrip(os.sep)
    if not real:
        return "workspace"
    base = _slugify(os.path.basename(real)) or "workspace"
    digest = hashlib.sha1(real.encode("utf-8")).hexdigest()[:8]
    return f"{base}-{digest}"


def _chat_workspace(chat: dict) -> str:
    root = str(chat.get("root") or "").strip()
    if root:
        return workspace_slug_for_root(root)
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
            # cascade: drop this chat's plan folder so it doesn't orphan on disk
            delete_plan(_chat_workspace(obj), chat_id=str(obj.get("id")))
            return


def remove_workspace_vectors(roots: list) -> None:
    """Delete the per-workspace RAG vector store file for each removed root.

    Keeps memory/search space in sync when a whole workspace is deleted from
    the sidebar. ``roots`` are the absolute project paths that were removed;
    the vector file uses the hashed workspace slug.
    """
    import shutil

    vdir = vector_db_dir()
    for r in roots or []:
        if not r or not isinstance(r, str):
            continue
        slug = workspace_slug_for_root(r)
        real = os.path.realpath(r).rstrip(os.sep)
        legacy_slug = _slugify(os.path.basename(real)) or "workspace"
        # Backward compat: also remove the legacy file without hash if present.
        for suffix in (".vectors.sqlite", ".vectors.sqlite-wal", ".vectors.sqlite-shm"):
            for cand in (slug, legacy_slug):
                try:
                    os.remove(os.path.join(vdir, f"{cand}{suffix}"))
                except OSError:
                    pass
        # cascade: drop the whole workspace plan folder so it doesn't orphan
        for cand in (slug, legacy_slug):
            plan_ws = os.path.join(plans_dir(), cand)
            if os.path.isdir(plan_ws):
                try:
                    shutil.rmtree(plan_ws)
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


def _parse_skill_frontmatter(raw: str) -> tuple[str, str, str, list[str]]:
    """Return ``(name, slug, description, fa_keywords)`` parsed from a skill markdown file.

    The first ``---`` fenced block is treated as YAML frontmatter. Falls back to
    deriving the name from the first ``# Heading`` line or the first non-empty
    line when frontmatter is absent.
    """
    name = ""
    slug = ""
    description = ""
    fa_keywords: list[str] = []
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
                elif key == "fa_keywords":
                    fa_keywords = [k.strip() for k in val.split(",") if k.strip()]
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
        slug = _slugify(name)
    return name, slug, description, fa_keywords


def _find_skill_dir(name_or_slug: str) -> str | None:
    """Locate a skill's directory by name or slug. Returns None when missing."""
    name_or_slug = str(name_or_slug or "").strip()
    if not name_or_slug:
        return None
    # Prefer the exact slug dir (hash-based for non-ASCII names) — but only
    # when the name slugifies to something. A non-ASCII name must never match
    # the shared legacy ``skills/skill/`` folder; if its own hash dir is
    # missing it is found by the frontmatter name scan below.
    slug = _raw_slug(name_or_slug)
    if slug:
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
            name, _, _, _ = _parse_skill_frontmatter(_read_text(md))
            if name and name.strip() == name_or_slug:
                return p
    return None


def save_skill(
    name: str,
    slug: str,
    description: str,
    content: str,
    fa_keywords: list[str] | None = None,
) -> None:
    """Persist a skill as ``skills/<slug>/skill.md`` with YAML frontmatter.

    The frontmatter carries ``name``/``slug``/``description``/``fa_keywords``. The rest of
    the file is the skill body. An empty ``slug`` falls back to the slugified
    name and then to a stable hash, so distinct names never share a folder.
    """
    with _LOCK:
        _migrate_legacy_db()
        name = str(name or "").strip()
        slug = str(slug or "").strip() or _skill_slug(name)
        content = str(content or "")
        d = _skill_dir(slug)
        os.makedirs(d, exist_ok=True)
        # Strip any pre-existing frontmatter so we don't duplicate it.
        if content.startswith("---"):
            end = content.find("\n---", 3)
            if end != -1:
                content = content[end + 4:].lstrip("\n")
        fa_list = [str(k or "").strip() for k in (fa_keywords or []) if str(k or "").strip()]
        front = (
            "---\n"
            f"name: {name}\n"
            f"slug: {slug}\n"
            f"description: {str(description or '').strip()}\n"
            + (f"fa_keywords: {', '.join(fa_list)}\n" if fa_list else "")
            + "---\n\n"
        )
        _atomic_write(os.path.join(d, "skill.md"), front + content)
    invalidate_skills_cache()


def _skills_fingerprint() -> tuple:
    """Cheap fingerprint of the skills folder: (dir mtime, entry count).

    Directory mtime updates on entry create/delete/rename, and the count
    covers content edits that do not change the count — writers
    (save_skill/delete_skill) invalidate the cache themselves. This only
    guards external edits (manual file changes), so it favors cheapness over
    exactness; it runs every turn."""
    base = skills_dir()
    try:
        st = os.stat(base)
        return (st.st_mtime_ns, len(os.listdir(base)))
    except OSError:
        return (0, -1)


# list_skills cache: output plus the fingerprint that validates it. Needed
# several times per turn (build_turn_context, _skill_names_to_strip,
# sync_builtin_skills) without re-reading every skill.md.
_skills_cache: tuple[tuple, list[dict]] | None = None


def invalidate_skills_cache() -> None:
    """Clear the list_skills cache — after every skill write/delete."""
    global _skills_cache
    _skills_cache = None


def list_skills() -> list[dict]:
    """Return all skills as ``{name, slug, description, path, content, fa_keywords}``.

    Cached until the skills folder fingerprint changes; internal writers
    (save_skill/delete_skill) invalidate the cache so changes appear at once."""
    global _skills_cache
    fp = _skills_fingerprint()
    if _skills_cache is not None and _skills_cache[0] == fp:
        return _skills_cache[1]
    out = _list_skills_uncached()
    _skills_cache = (fp, out)
    return out


def _list_skills_uncached() -> list[dict]:
    """Read all skill.md files from disk (no cache)."""
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
            name, slug, description, fa_keywords = _parse_skill_frontmatter(raw)
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
                    "fa_keywords": fa_keywords,
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

            shutil.rmtree(d)
        except OSError:
            return False
        # rmtree succeeded — verify removal before reporting success
        if os.path.exists(d):
            return False
        invalidate_skills_cache()
        return True


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
        except (ValueError, TypeError) as exc:
            raise ValueError(f"Invalid MCP config JSON: {exc}") from exc
        if not isinstance(parsed, dict):
            raise ValueError("MCP config must be a JSON object")  # noqa: TRY004
        _atomic_write_json(
            _mcp_file(name),
            {"name": name, "config": parsed},
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
            shutil.rmtree(target)
        except OSError:
            return False
        return not os.path.exists(target)


def prune_orphan_plans() -> int:
    """Delete plan folders whose chat (or whole workspace) no longer exists.

    Plans live under ``plan/<ws>/<chat-id>/``; when a chat or workspace is
    removed without its plan folder being cleaned up (e.g. older builds, or a
    crash mid-delete) those folders are orphaned on disk. This walks every plan
    folder and removes any whose ``<chat-id>`` does not match a live chat in the
    same workspace, plus any whole-workspace plan folder whose workspace slug
    matches no live chat. Returns the number of folders removed. Best-effort:
    never raises.
    """
    import shutil

    try:
        base = plans_dir()
        if not os.path.isdir(base):
            return 0
        # map: workspace-slug -> set(chat-id slugs) that still exist on disk
        live: dict[str, set[str]] = {}
        for chat in _iter_chat_files():
            ws = _safe_file(_chat_workspace(chat), "workspace")
            cid = _safe_file(str(chat.get("id") or "chat"), "chat")
            live.setdefault(ws, set()).add(cid)
        removed = 0
        for ws in sorted(os.listdir(base)):
            ws_dir = os.path.join(base, ws)
            if not os.path.isdir(ws_dir):
                continue
            live_cids = live.get(ws)
            if not live_cids:
                # whole workspace is gone — drop its plan folder entirely
                try:
                    shutil.rmtree(ws_dir)
                    if not os.path.exists(ws_dir):
                        removed += 1
                except OSError:
                    pass
                continue
            for cid in sorted(os.listdir(ws_dir)):
                d = os.path.join(ws_dir, cid)
                if not os.path.isdir(d):
                    continue
                if cid not in live_cids:
                    try:
                        shutil.rmtree(d)
                        if not os.path.exists(d):
                            removed += 1
                    except OSError:
                        pass
        return removed
    except OSError:
        return 0


# -- schedules (automatic task scheduling, Codex-style) ------------------------ #
# Each task is a ``schedules/<id>.json`` file; run history lives in
# ``schedules/runs/<run-id>.json`` with a ``schedule_id`` field.
# All writes are atomic (tmp + os.replace) under the module lock.


def _schedule_file(schedule_id: str) -> str:
    return os.path.join(schedules_dir(), f"{_safe_file(schedule_id, 'schedule')}.json")


def list_schedules() -> list[dict]:
    """Return all scheduled tasks (sorted by created_at)."""
    base = schedules_dir()
    if not os.path.isdir(base):
        return []
    out: list[dict] = []
    with _LOCK:
        for fn in sorted(os.listdir(base)):
            if not fn.endswith(".json"):
                continue
            obj = _read_json(os.path.join(base, fn))
            if isinstance(obj, dict) and obj.get("id"):
                out.append(obj)
    out.sort(key=lambda t: float(t.get("created_at") or 0))
    return out


def get_schedule(schedule_id: str) -> dict | None:
    """Read one task by id; None when missing."""
    if not schedule_id:
        return None
    obj = _read_json(_schedule_file(str(schedule_id)))
    return obj if isinstance(obj, dict) and obj.get("id") else None


def save_schedule(task: dict) -> dict:
    """Create/update a scheduled task (atomic). Generates an id when empty."""
    import uuid

    with _LOCK:
        _migrate_legacy_db()
        task = dict(task or {})
        sid = str(task.get("id") or "").strip() or f"sch-{uuid.uuid4().hex[:8]}"
        now = _now()
        task["id"] = sid
        if not isinstance(task.get("created_at"), (int, float)):
            task["created_at"] = now
        task["updated_at"] = now
        task["name"] = str(task.get("name") or task.get("title") or "تسک زمان‌بندی").strip() or "تسک زمان‌بندی"
        task["prompt"] = str(task.get("prompt") or "")
        task["cron"] = str(task.get("cron") or "").strip()
        task["enabled"] = bool(task.get("enabled", True))
        task["root"] = str(task.get("root") or "")
        task["mode"] = str(task.get("mode") or "coder")
        task["provider_id"] = str(task.get("provider_id") or "")
        task["model"] = str(task.get("model") or "")
        if not isinstance(task.get("run_count"), int):
            task["run_count"] = int(task.get("run_count") or 0)
        # next_run ذخیره‌شده قدیمی (stale) را نگه ندار: اگر در گذشته است،
        # پنل ساعت گذشته نشان می‌دهد و حلقه ممکن است burst بزند. مقدار تازه
        # همیشه با compute_next_run از روی max(last_run, now) حساب می‌شود.
        try:
            nxt = float(task.get("next_run") or 0)
        except (TypeError, ValueError):
            nxt = 0.0
        if nxt and nxt <= now:
            task.pop("next_run", None)
        _atomic_write_json(_schedule_file(sid), task)
        return task


def delete_schedule(schedule_id: str) -> bool:
    """حذف یک تسک زمان‌بندی. تاریخچه اجراها نگه داشته می‌شود. True وقتی حذف شد."""
    if not schedule_id:
        return False
    with _LOCK:
        try:
            os.remove(_schedule_file(str(schedule_id)))
            return True
        except OSError:
            return False


def _schedule_run_file(run_id: str) -> str:
    return os.path.join(schedule_runs_dir(), f"{_safe_file(run_id, 'run')}.json")


def list_schedule_runs(schedule_id: str = "", limit: int = 50) -> list[dict]:
    """تاریخچه اجراها (جدیدترین اول). با schedule_id خالی همه اجراها."""
    base = schedule_runs_dir()
    if not os.path.isdir(base):
        return []
    out: list[dict] = []
    try:
        files = sorted(os.listdir(base), reverse=True)
    except OSError:
        return []
    with _LOCK:
        for fn in files:
            if not fn.endswith(".json"):
                continue
            obj = _read_json(os.path.join(base, fn))
            if not isinstance(obj, dict) or not obj.get("id"):
                continue
            if schedule_id and str(obj.get("schedule_id") or "") != str(schedule_id):
                continue
            out.append(obj)
            if len(out) >= max(1, int(limit or 50)):
                break
    out.sort(key=lambda r: float(r.get("started_at") or 0), reverse=True)
    return out


def save_schedule_run(run: dict) -> dict:
    """ثبت یک اجرای زمان‌بندی (اتمیک). id می‌سازد اگر خالی باشد."""
    import uuid

    with _LOCK:
        run = dict(run or {})
        rid = str(run.get("id") or "").strip() or f"run-{uuid.uuid4().hex[:8]}"
        run["id"] = rid
        if not isinstance(run.get("started_at"), (int, float)):
            run["started_at"] = _now()
        _atomic_write_json(_schedule_run_file(rid), run)
        return run


def prune_schedule_runs(schedule_id: str, keep: int = 50) -> int:
    """اجراهای قدیمی یک تسک را حذف کن؛ فقط ``keep`` تای جدید می‌ماند."""
    runs = list_schedule_runs(schedule_id, limit=10_000)
    doomed = runs[max(1, int(keep or 50)):]
    removed = 0
    with _LOCK:
        for r in doomed:
            try:
                os.remove(_schedule_run_file(str(r.get("id"))))
                removed += 1
            except OSError:
                pass
    return removed


def delete_schedule_runs(schedule_id: str) -> int:
    """همه اجراهای یک تسک (چت اینباکس آن کرون) را پاک کن؛ تعداد حذف‌شده."""
    if not schedule_id:
        return 0
    runs = list_schedule_runs(str(schedule_id), limit=10_000)
    removed = 0
    with _LOCK:
        for r in runs:
            try:
                os.remove(_schedule_run_file(str(r.get("id"))))
                removed += 1
            except OSError:
                pass
    return removed


def delete_schedule_run(run_id: str) -> bool:
    """حذف تکی یک ران با id؛ True وقتی فایلی حذف شد."""
    if not str(run_id or "").strip():
        return False
    with _LOCK:
        try:
            os.remove(_schedule_run_file(str(run_id)))
            return True
        except OSError:
            return False


def delete_orphan_schedule_runs() -> int:
    """ران‌های یتیم (schedule_id بدون تسک زنده) را پاک کن؛ تعداد حذف‌شده.

    وقتی تسکی حذف می‌شود تاریخچه‌اش می‌ماند؛ این تابع آن باقیمانده‌ها را
    جمع می‌کند تا اینباکس تسک تازه تمیز بماند. Best-effort و بدون raise."""
    try:
        live_ids = {str(t.get("id")) for t in list_schedules() if isinstance(t, dict) and t.get("id")}
    except OSError:
        return 0
    try:
        runs = list_schedule_runs("", limit=10_000)
    except OSError:
        return 0
    removed = 0
    with _LOCK:
        for r in runs:
            if not isinstance(r, dict):
                continue
            sid = str(r.get("schedule_id") or "")
            if sid and sid in live_ids:
                continue
            try:
                os.remove(_schedule_run_file(str(r.get("id"))))
                removed += 1
            except OSError:
                pass
    return removed


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
                slug = str(slug or "").strip() or _skill_slug(name)
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
