/**
 * Live backend events over one WebSocket (`/ws/events`).
 *
 * The backend fingerprints `git status --porcelain` for every registered root
 * on a 1.5s beat and pushes ONE `{"kind":"change","root","files":[..]}`
 * event when the fingerprint changes — `files` lists the changed paths, so
 * both the git views (review panel) and open code-file viewers can refresh
 * silently. No polling loops per panel: every surface registers a callback
 * and the socket is shared.
 *
 * Reconnects with a 3s backoff. A dead socket degrades to silence — callers
 * keep their own slow fallback poll if they need one.
 */

type ChangeCb = (root: string, files: string[]) => void;

const changeCbs = new Set<ChangeCb>();
const rootRefs = new Map<string, number>();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;

function sendRoots() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ roots: [...rootRefs.keys()] }));
  }
}

function scheduleReconnect() {
  if (disposed || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, 3000);
}

async function connect() {
  const { ensureSidecar } = await import("./api");
  const base = await ensureSidecar();
  if (!base) {
    // No backend yet — try again on the next root registration.
    scheduleReconnect();
    return;
  }
  const wsUrl = base.replace(/^http/, "ws") + "/ws/events";
  const s = new WebSocket(wsUrl);
  socket = s;
  s.onopen = sendRoots;
  s.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data) as {
        kind: string;
        root: string;
        files?: string[];
      };
      if (data.kind === "change") {
        changeCbs.forEach((cb) => cb(data.root, data.files ?? []));
      }
    } catch {
      /* malformed frame — ignore */
    }
  };
  s.onclose = () => {
    if (socket === s) socket = null;
    scheduleReconnect();
  };
  s.onerror = () => s.close();
}

/** Subscribe to git/file changes for `root`. Returns an unsubscribe fn. */
export function onGitChange(root: string, cb: ChangeCb): () => void {
  changeCbs.add(cb);
  rootRefs.set(root, (rootRefs.get(root) ?? 0) + 1);
  sendRoots();
  if (!socket && !reconnectTimer) void connect();
  return () => {
    changeCbs.delete(cb);
    const n = (rootRefs.get(root) ?? 1) - 1;
    if (n <= 0) rootRefs.delete(root);
    else rootRefs.set(root, n);
    sendRoots();
  };
}
