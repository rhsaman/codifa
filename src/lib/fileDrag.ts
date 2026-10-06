// Shared file-drag detection for chat panels and window drops.
// File drops belong to the chat composer (attach to input), never to
// window moves, so every drop zone uses the same check.
export function isFileDrag(
  types: ArrayLike<string> | Iterable<string> | undefined | null,
): boolean {
  if (!types) return false;
  try {
    for (const t of Array.from(types as unknown as Iterable<string>)) {
      if (t === "Files") return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function hasFileDrop(
  files: { length?: number } | undefined | null,
): boolean {
  try {
    return (files?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
