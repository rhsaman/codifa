import { useEffect, useRef } from "react";
import { api } from "../lib/fs";
import { listAllScheduleRuns } from "../lib/api";
import { playAlarm } from "../lib/alarm";
import {
  ensureScheduleNotificationPermission,
  findFinishedScheduleRuns,
  notifyScheduleRun,
  notifyScheduleRunBatch,
} from "../lib/schedule-notify";
import { useScheduleRunsLive } from "../lib/scheduleRunsLive";
import { useStore } from "../lib/store";
import { useViewerTabs } from "../lib/viewerTabs";
import type { ScheduleRun } from "../types";

/** How often the run rows are polled while the app is open. */
const POLL_MS = 15000;

/** Opens the inbox page (what clicking an OS notification does). */
function openInbox(): void {
  useViewerTabs.getState().openInbox();
  useStore.getState().setScheduleInboxOpen(true);
}

/**
 * Headless watcher for scheduled-task runs, mounted once in App.
 *
 * It owns the two things that must work while the inbox page is CLOSED:
 *  - it publishes the polled run rows (`useScheduleRunsLive`), which the
 *    dock's Inbox icon turns into its unread badge;
 *  - it raises the OS notification + alarm when a run FINISHES.
 *
 * A run that is still `running` never notifies and never counts toward the
 * badge — only the transition to done/error does (`findFinishedScheduleRuns`
 * ignores live runs, the first poll only builds a baseline, and a run that was
 * already finished is never announced twice).
 */
export function ScheduleRunsWatcher(): null {
  const prevStatusesRef = useRef<Map<string, ScheduleRun["status"]> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const out = await listAllScheduleRuns(50);
        // "error" = sidecar not ready yet: keep the baseline untouched and
        // let the next tick (or the sidecar-changed event) retry.
        if (cancelled || "error" in out) return;
        useScheduleRunsLive.getState().setRuns(out);
        const prev = prevStatusesRef.current;
        if (prev !== null) {
          const finished = findFinishedScheduleRuns(prev, out);
          for (const r of finished) {
            playAlarm(r.status === "error" ? "error" : "alert");
          }
          if (finished.length > 0 && (await ensureScheduleNotificationPermission())) {
            if (finished.length === 1) {
              const r = finished[0];
              const name = useStore
                .getState()
                .schedules.find((t) => t.id === r.schedule_id)?.name;
              notifyScheduleRun(r, name, openInbox);
            } else {
              notifyScheduleRunBatch(finished.length, openInbox);
            }
          }
        }
        prevStatusesRef.current = new Map(out.map((r) => [r.id, r.status]));
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    // A sidecar that (re)starts after the first failed poll: refresh at once
    // instead of waiting out the interval.
    const unsub = api.onSidecarChanged(() => void tick());
    return () => {
      cancelled = true;
      clearInterval(t);
      unsub();
    };
  }, []);

  return null;
}
