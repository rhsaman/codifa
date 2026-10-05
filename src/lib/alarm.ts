// Notification alarm sounds, played from the renderer via HTMLAudioElement.
// The mp3 files live in /sounds at the project root and are imported as URLs,
// so Vite bundles them for both the dev server and the packaged app
// (dist/index.html loaded via file:// uses relative asset paths).

import alertUrl from "../../sounds/alert.mp3";
import errorUrl from "../../sounds/error.mp3";

/** alert: the agent needs the user (ask prompt) or a turn/run finished OK.
 *  error: the turn/run failed. */
export type AlarmKind = "alert" | "error";

const ALARM_URLS: Record<AlarmKind, string> = {
  alert: alertUrl,
  error: errorUrl,
};

// Keep playing elements referenced until they end: a garbage-collected Audio
// can be cut off before playback finishes (and Chrome may skip it entirely).
const ACTIVE = new Set<HTMLAudioElement>();

/** Fire-and-forget alarm playback. Never throws: a blocked or missing sound
 *  (autoplay policy, file absent) must not break the calling event path — it
 *  is logged so a silent-alarm report can be diagnosed from the console.
 *  A fresh Audio element per play lets overlapping alarms ring in full. */
export function playAlarm(kind: AlarmKind): void {
  try {
    const audio = new Audio(ALARM_URLS[kind]);
    audio.preload = "auto";
    ACTIVE.add(audio);
    audio.addEventListener("ended", () => ACTIVE.delete(audio), { once: true });
    audio.play().catch((err: unknown) => {
      console.warn(`[alarm] '${kind}' playback failed:`, err);
      ACTIVE.delete(audio);
    });
  } catch (err) {
    console.warn("[alarm] could not start playback:", err);
  }
}
