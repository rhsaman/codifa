// src/lib/browserViewport.ts
var VIEWPORT_LIMITS = {
  minWidth: 200,
  maxWidth: 7680,
  minHeight: 200,
  maxHeight: 4320
};
var DEFAULT_VIEWPORT_SIZE = { width: 1280, height: 800 };
function fitWidthTarget(paneW, capW, minW = VIEWPORT_LIMITS.minWidth) {
  if (!Number.isFinite(paneW) || paneW <= 0) return capW;
  return Math.max(minW, Math.min(capW, Math.round(paneW)));
}
function capAfterPoll(own, w, h, capW) {
  if (own && own.w === w && own.h === h) return capW;
  return w;
}
function frameZoom(paneW, paneH, vw, vh) {
  if (!Number.isFinite(paneW) || !Number.isFinite(paneH) || paneW <= 0 || paneH <= 0) return 1;
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) return 1;
  return Math.min(1, paneW / vw, paneH / vh);
}
function shouldSyncViewportDrafts(prevW, prevH, nextW, nextH, editing) {
  if (editing) return false;
  return prevW !== nextW || prevH !== nextH;
}
function toFinite(n, fallback) {
  return Number.isFinite(n) ? n : fallback;
}
function clampViewportSize(width, height) {
  const w = toFinite(Math.round(width), DEFAULT_VIEWPORT_SIZE.width);
  const h = toFinite(Math.round(height), DEFAULT_VIEWPORT_SIZE.height);
  return {
    width: Math.max(VIEWPORT_LIMITS.minWidth, Math.min(VIEWPORT_LIMITS.maxWidth, w)),
    height: Math.max(VIEWPORT_LIMITS.minHeight, Math.min(VIEWPORT_LIMITS.maxHeight, h))
  };
}

// tests/browserViewport.test.ts
var failures = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${extra === void 0 ? "" : ` \u2014 ${JSON.stringify(extra)}`}`);
  }
}
console.log("fitWidthTarget");
check("narrow pane shrinks to the pane width", fitWidthTarget(700, 1280) === 700, fitWidthTarget(700, 1280));
check("wide pane grows back to the cap", fitWidthTarget(1600, 1280) === 1280, fitWidthTarget(1600, 1280));
check("cap is never exceeded", fitWidthTarget(4e3, 900) === 900, fitWidthTarget(4e3, 900));
check("zero pane keeps the cap", fitWidthTarget(0, 1280) === 1280, fitWidthTarget(0, 1280));
check("NaN pane keeps the cap", fitWidthTarget(Number.NaN, 1280) === 1280, fitWidthTarget(Number.NaN, 1280));
check("clamped to the minimum width", fitWidthTarget(10, 1280) === VIEWPORT_LIMITS.minWidth, fitWidthTarget(10, 1280));
check("rounds fractional pane widths", fitWidthTarget(1024.6, 1280) === 1025, fitWidthTarget(1024.6, 1280));
console.log("capAfterPoll");
check("own poll keeps the cap", capAfterPoll({ w: 700, h: 800 }, 700, 800, 1280) === 1280, capAfterPoll({ w: 700, h: 800 }, 700, 800, 1280));
check("external resize becomes the cap", capAfterPoll({ w: 700, h: 800 }, 1024, 800, 1280) === 1024, capAfterPoll({ w: 700, h: 800 }, 1024, 800, 1280));
check("height-only change becomes the cap", capAfterPoll({ w: 700, h: 800 }, 700, 600, 1280) === 700, capAfterPoll({ w: 700, h: 800 }, 700, 600, 1280));
check("no prior apply adopts the polled size", capAfterPoll(null, 900, 700, 1280) === 900, capAfterPoll(null, 900, 700, 1280));
var keptCap = capAfterPoll({ w: 700, h: 800 }, 700, 800, 1280);
check("cap survives a fit-shrink and grows back", fitWidthTarget(1400, keptCap) === 1280, fitWidthTarget(1400, keptCap));
console.log("clampViewportSize");
check("keeps an in-range size", JSON.stringify(clampViewportSize(1024, 768)) === JSON.stringify({ width: 1024, height: 768 }));
check("clamps below the minimum", clampViewportSize(1, 1).width === VIEWPORT_LIMITS.minWidth);
check("clamps above the maximum", clampViewportSize(99999, 99999).width === VIEWPORT_LIMITS.maxWidth);
check("falls back on NaN", clampViewportSize(Number.NaN, Number.NaN).width === DEFAULT_VIEWPORT_SIZE.width);
console.log("frameZoom");
check("never upscales past 1:1", frameZoom(2e3, 2e3, 1280, 800) === 1, frameZoom(2e3, 2e3, 1280, 800));
check("shrinks to fit a narrow pane", frameZoom(640, 2e3, 1280, 800) === 0.5, frameZoom(640, 2e3, 1280, 800));
check("shrinks to fit a short pane", frameZoom(2e3, 400, 1280, 800) === 0.5, frameZoom(2e3, 400, 1280, 800));
check("picks the tighter axis", frameZoom(640, 400, 1280, 800) === 0.5, frameZoom(640, 400, 1280, 800));
check("a small viewport stays 1:1 in a big pane", frameZoom(1200, 900, 375, 667) === 1, frameZoom(1200, 900, 375, 667));
check("degenerate pane falls back to 1", frameZoom(0, 0, 1280, 800) === 1, frameZoom(0, 0, 1280, 800));
check("degenerate viewport falls back to 1", frameZoom(800, 600, 0, 0) === 1, frameZoom(800, 600, 0, 0));
check("NaN inputs fall back to 1", frameZoom(Number.NaN, 600, 1280, 800) === 1, frameZoom(Number.NaN, 600, 1280, 800));
console.log("shouldSyncViewportDrafts");
check("never syncs while editing", shouldSyncViewportDrafts(1280, 800, 900, 800, true) === false);
check("syncs on a real change", shouldSyncViewportDrafts(1280, 800, 900, 800, false) === true);
check("ignores an identical size", shouldSyncViewportDrafts(1280, 800, 1280, 800, false) === false);
if (failures > 0) {
  console.log(`
${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
