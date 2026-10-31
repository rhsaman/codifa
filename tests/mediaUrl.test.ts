/**
 * `codifa-media://` resolution — the wire contract between the agent's media
 * tools and the chat renderer. If these drift, generated images render as
 * broken placeholders even though the file exists on disk.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

// esbuild bundles this module WITH its deps — mediaUrl is dependency-free.
import {
  codifaMediaPath,
  isMediaImagePath,
  isMediaVideoPath,
  mediaFileUrl,
  resolveLocalMedia,
} from "../src/lib/mediaUrl";

test("codifaMediaPath extracts the workspace path and rejects foreign schemes", () => {
  assert.equal(codifaMediaPath("codifa-media://media/image-x.png"), "media/image-x.png");
  assert.equal(codifaMediaPath("CODIFA-MEDIA://media/a.mp4"), "media/a.mp4");
  assert.equal(codifaMediaPath("codifa-media://media/a.png?x=1") === null, false);
  assert.equal(codifaMediaPath("https://example.com/a.png"), null);
  assert.equal(codifaMediaPath("file:///etc/passwd"), null);
  assert.equal(codifaMediaPath(undefined), null);
  assert.equal(codifaMediaPath(null), null);
  assert.equal(codifaMediaPath(""), null);
});

test("mediaFileUrl encodes the chat-scoped virtual path (no root on the wire)", () => {
  const url = mediaFileUrl("media/chat-slug/a b.png", "http://127.0.0.1:8899");
  assert.ok(url.startsWith("http://127.0.0.1:8899/media/file?"));
  assert.ok(url.includes("path=" + encodeURIComponent("media/chat-slug/a b.png")));
  // No workspace root, no chat id — the backend resolves inside its own sandbox.
  assert.ok(!url.includes("root="));
  // A trailing slash on the base must not double up.
  assert.ok(!url.includes("//media/file"));
  // No backend yet → the caller's fallback, not a malformed URL.
  assert.ok(mediaFileUrl("media/a.png", null).startsWith("/media/file?"));
});

test("resolveLocalMedia resolves the codifa-media scheme and bare media paths", () => {
  const resolved = resolveLocalMedia(
    "codifa-media://media/image-x.png",
    "http://127.0.0.1:8899",
  );
  assert.ok(resolved);
  assert.equal(resolved!.video, false);
  assert.equal(resolved!.path, "media/image-x.png");
  assert.ok(resolved!.url.includes("/media/file?"));

  const bare = resolveLocalMedia("media/clip-01.mp4", "http://127.0.0.1:8899");
  assert.ok(bare);
  assert.equal(bare!.video, true);

  // Everything that must stay untouched stays untouched.
  assert.equal(resolveLocalMedia("https://x/y.png", "http://b"), null);
  assert.equal(resolveLocalMedia("data:image/png;base64,xx", "http://b"), null);
  assert.equal(resolveLocalMedia("#anchor", "http://b"), null);
  assert.equal(resolveLocalMedia("/abs/path.png", "http://b"), null);
  assert.equal(resolveLocalMedia("../relative.md", "http://b"), null);
  assert.equal(resolveLocalMedia("plain text", "http://b"), null);
  // Known backend absent: nothing to resolve into.
  assert.equal(resolveLocalMedia("codifa-media://media/a.png", null), null);
});

test("extension classification decides img vs video rendering", () => {
  for (const p of ["a.png", "a.JPG", "a.webp", "a.jpeg", "a.gif"]) {
    assert.ok(isMediaImagePath(p), p);
    assert.equal(isMediaVideoPath(p), false, p);
  }
  for (const p of ["a.mp4", "a.WEBM", "a.mov", "a.m4v"]) {
    assert.ok(isMediaVideoPath(p), p);
    assert.equal(isMediaImagePath(p), false, p);
  }
});
