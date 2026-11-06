import { api } from "./fs";

/** Save one media file. Desktop: the NATIVE save dialog (`save_media_as`
 *  command — the webview's `<a download>` does nothing). Pass `dataUrl` when
 *  the bytes only exist in the page (chat attachments): the backend saves
 *  those bytes and `url`/`virtualPath` are ignored by the dialog flow.
 *  Web mode (no OS dialog): fetch → blob → object-URL click. */
export async function downloadMedia(
  url: string,
  virtualPath: string,
  dataUrl?: string,
): Promise<"saved" | "downloaded" | "cancelled"> {
  const name = virtualPath.split("/").pop() || "media";
  if (api.saveMediaAs) {
    const dest = await api.saveMediaAs(virtualPath, name, dataUrl);
    return dest ? "saved" : "cancelled";
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 5_000);
  return "downloaded";
}
