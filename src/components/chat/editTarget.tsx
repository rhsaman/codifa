import { extractMentionSkills } from '../../lib/skills'
import { sanitizeImageDataUrl, useStore } from '../../lib/store'
import type { ChatEditTarget } from '../../types'

export const EDIT_TARGET_COMMANDS = new Set(["plugin", "artifact"]);

/** The folder holding a file path (a skill row points at its SKILL.md). */
export function folderOf(p?: string): string {
  if (!p) return "";
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : "";
}

/** Pin (open) the update session for a named target whose folder is known.
 *  ONE session per chat: `setChatEditTarget` refuses a DIFFERENT target while
 *  a badge is open — the × on the badge is the only way out. False ⇒ nothing
 *  was pinned (unknown folder, or another session holds the chat). */
export function openEditTargetSession(
  chatId: string,
  target: ChatEditTarget["target"],
  name: string,
  dirs: Record<string, Record<string, string>>,
): boolean {
  const dir = dirs[target]?.[name];
  if (!dir) return false;
  return useStore.getState().setChatEditTarget(chatId, {
    target,
    action: "update",
    name,
    path: dir,
  });
}

/** `chatId:target:name` pins the user closed with the badge's ×. The turn that
 *  produced the pin keeps streaming and often emits the SAME `edit_target`
 *  event after the click; re-pinning from that echo would make the × a lie
 *  (the badge returns and Build stays forced). Deliberate `/plugin update`
 *  commands re-open the session through openEditTargetSession, which does not
 *  consult this set. */
export const dismissedEditTargets = new Set<string>();

export function dismissedEditTargetKey(chatId: string, target: string, name: string): string {
  return `${chatId}:${target}:${name}`;
}

/** × on the badge: end the session and remember the target was closed, so the
 *  trailing `edit_target` events of the running turn cannot re-pin it. */
export function dismissEditTarget(chatId: string, t: ChatEditTarget | null | undefined): void {
  if (!t) return;
  dismissedEditTargets.add(dismissedEditTargetKey(chatId, t.target, t.name));
  // FIFO trim: only recent closes can be re-echoed by a live stream.
  if (dismissedEditTargets.size > 200) {
    const oldest = dismissedEditTargets.values().next().value;
    if (oldest) dismissedEditTargets.delete(oldest);
  }
  useStore.getState().clearChatEditTarget(chatId);
}

/** System-prompt suffix while an edit badge is open: the agent must know it is
 *  working INSIDE the pinned folder — and for plugins, where secrets live
 *  (the runner injects the plugin folder's .env into every script run). */
export function editTargetSuffix(t?: ChatEditTarget | null): string {
  if (!t) return "";
  const base =
    `EDIT SESSION ACTIVE: you are updating the ${t.target} "${t.name}" — its folder on disk is ${t.path}. ` +
    "Make every change inside that folder and nowhere else. The edit session stays open across turns " +
    "until the user closes the badge above the composer — never treat the session as finished on your own, " +
    "and never ask the user to re-run the update command for follow-up changes. " +
    "The session only pins WHERE you edit; it does not turn every request into more editing. When the " +
    "user asks to RUN this target (fire its script, trade through its plugin, run its build), run it " +
    "now in this Build-mode session — do not switch to updating the target instead.";
  if (t.target === "plugin") {
    return (
      base +
      " Never hard-code secrets or API keys into the script source: write them into the plugin's own " +
      ".env file (KEY=value lines in that same folder) — the script runner injects them as environment " +
      "variables when the plugin's scripts run."
    );
  }
  return base;
}

/**
 * Extract @skill mentions from a prompt and return the matched skill names plus
 * the prompt with those @mentions stripped (the model must not see raw @tokens;
 * the stored transcript keeps the original text with the @mentions).
 *
 * The canonical mention token is the skill's slug (e.g.
 * "@anthropic-frontend-design") — space-free and unambiguous. A legacy fallback
 * also matches display names that contain spaces (e.g. "@Anthropic Frontend
 * Design") for text pasted from before the slug-based flow. The actual
 * extraction logic lives in ../lib/skills (extractMentionSkills) so it can be
 * unit-tested independently of the React component.
 */
export const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "heic",
  "heif",
]);

/** Drop corrupt image data URLs before send (truncated snapshots, bad base64).
 *  Keeps path-only entries and the text; warns for each dropped image. */
export function cleanImagesForSend<T extends { path: string; name?: string; dataUrl?: string }>(imgs: T[]): T[] {
  const out: T[] = [];
  for (const img of imgs ?? []) {
    if (!img) continue;
    if (!img.dataUrl) {
      out.push(img);
      continue;
    }
    const clean = sanitizeImageDataUrl(img.dataUrl);
    if (clean) {
      out.push(clean === img.dataUrl ? img : { ...img, dataUrl: clean });
    } else {
      console.warn("[chat] dropping corrupt image data URL (not sent):", img.path);
    }
  }
  return out;
}

export function relFromRoot(root: string, p: string): string | null {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root).split("/");
  const f = norm(p).split("/");
  let i = 0;
  while (i < r.length && i < f.length && r[i] === f[i]) i++;
  if (i < r.length) return null;
  const rel = f.slice(i).join("/");
  return rel || null;
}

/** Fixed width of the context-breakdown popover (also used to clamp its
 *  horizontal anchor so it never overflows the viewport). */
