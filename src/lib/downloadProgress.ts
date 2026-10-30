/**
 * Parse a DOWNLOAD progress line out of a terminal output tail.
 *
 * While an agent command runs, its output tail is streamed live into the
 * tool card (tool_output events). A download in progress announces itself
 * there in one of a few well-known formats; recognizing the newest line
 * turns the card into a real progress bar instead of a bare spinner.
 *
 * Recognized formats (stderr of a NON-tty run — the tool pipes, so this is
 * what actually arrives):
 *   curl default meter, one line per refresh:
 *     ` 12  1831M   12  224M    0     0  15.2M      0  0:02:00  0:00:14  0:01:46 15.2M`
 *     columns: %Total Total %Recv Recv %Xfer Xfer AvgDload AvgUpload Total Spent Left CurSpeed
 *   curl --progress-bar:
 *     `############################                              48.3%`
 *   wget bar:
 *     ` 45% [=======>                   ] 5,146,123  1.05M/s  eta 8s`
 */

export interface DownloadProgress {
  /** 0–100, the newest refresh's percentage. */
  percent: number
  /** Human bytes already received, when the format carries it ("224M"). */
  received?: string
  /** Human total size, when the format carries it ("1831M"). */
  total?: string
  /** Current or average speed ("15.2M", "1.05M/s"). */
  speed?: string
  /** Estimated time remaining ("0:01:46", "8s"). */
  eta?: string
}

const TIME_RE = /^\d+:\d{2}:\d{2}$/
const HUMAN_SIZE_RE = /^\d[\d,.]*[kKMGTP]?i?B?$/i

function looksLikeSize(token: string): boolean {
  return HUMAN_SIZE_RE.test(token) || /^\d+$/.test(token)
}

/** Scan the tail and parse the NEWEST recognizable progress line (the tail is
 *  chronological, so the last match is the freshest refresh). */
export function parseDownloadProgress(tail: string): DownloadProgress | null {
  if (!tail) return null;
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes("%")) continue;
    const parsed = parseCurlMeter(line) ?? parseCurlBar(line) ?? parseWgetBar(line);
    if (parsed) return parsed;
  }
  return null;
}

/** curl's default meter: 12 space-separated columns; the last three are
 *  h:m:s times, which is what keeps this from matching random percent text. */
function parseCurlMeter(line: string): DownloadProgress | null {
  const f = line.trim().split(/\s+/);
  if (f.length < 12) return null;
  if (!TIME_RE.test(f[8]) || !TIME_RE.test(f[9]) || !TIME_RE.test(f[10])) return null;
  const percent = Number(f[0]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  if (!looksLikeSize(f[1]) || !looksLikeSize(f[3])) return null;
  return {
    percent,
    total: f[1],
    received: f[3],
    speed: f[11] || f[6] || undefined,
    eta: f[10],
  };
}

/** curl --progress-bar: a run of `#` then the percentage. */
function parseCurlBar(line: string): DownloadProgress | null {
  const m = line.match(/^(#{2,})\s+(\d{1,3}(?:\.\d+)?)%\s*$/);
  if (!m) return null;
  const percent = Number(m[2]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return { percent };
}

/** wget: `45% [====>  ] 5,146,123 1.05M/s eta 8s` (bar optional in some modes). */
function parseWgetBar(line: string): DownloadProgress | null {
  const m = line.match(/^\s*(\d{1,3})%\s*(?:\[[= >]*\])?\s*([\d,.]+)?\s*([^\s]*\/s)?\s*(?:eta\s+(\S+))?/i);
  if (!m) return null;
  const percent = Number(m[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  if (!m[2] && !m[3] && !m[4]) return null;
  return {
    percent,
    received: m[2] || undefined,
    speed: m[3] || undefined,
    eta: m[4] || undefined,
  };
}
