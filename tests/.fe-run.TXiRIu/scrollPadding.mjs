// src/lib/scrollPadding.ts
function composerScrollPadding(composerH, cardH, diffBarH = null) {
  const card = cardH ? cardH + 10 : 0;
  const diff = diffBarH ? diffBarH + 8 : 0;
  return Math.max(210, composerH + card + diff + 24);
}
function jumpVisibleThreshold(paddingBottom, floatingH) {
  return Math.max(0, paddingBottom - floatingH);
}

// tests/scrollPadding.test.ts
var failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    console.error(`  \u274C ${name}`, extra ?? "");
  }
}
console.log("1) \u0628\u062F\u0648\u0646 \u06A9\u0627\u0631\u062A (\u062D\u0627\u0644\u062A \u0639\u0627\u062F\u06CC):");
{
  const idle = composerScrollPadding(142, null);
  check("\u06A9\u0627\u0645\u067E\u0648\u0632\u0631 \u062E\u0627\u0644\u06CC \u2192 \u062D\u062F\u0627\u0642\u0644 210px", idle === 210, idle);
  check("\u06A9\u0627\u0645\u067E\u0648\u0632\u0631 \u06A9\u0645\u06CC \u0628\u0644\u0646\u062F\u062A\u0631 \u0647\u0645 \u062D\u062F\u0627\u0642\u0644 210px \u0645\u06CC\u0645\u0627\u0646\u062F", composerScrollPadding(150, null) === 210);
}
console.log("2) \u0628\u0627 \u06A9\u0627\u0631\u062A \u0628\u0627\u0632 (ask/perm):");
{
  const withCard = composerScrollPadding(142, 200);
  check("\u0627\u0631\u062A\u0641\u0627\u0639 \u06A9\u0627\u0631\u062A + \u0641\u0627\u0635\u0644\u0647 10px + \u062D\u0627\u0634\u06CC\u0647 24px \u0627\u0636\u0627\u0641\u0647 \u0645\u06CC\u0634\u0648\u062F", withCard === 142 + 200 + 10 + 24, withCard);
  check("\u06A9\u0627\u0631\u062A \u0628\u0644\u0646\u062F (420px) padding \u0631\u0627 \u0628\u0632\u0631\u06AF \u0645\u06CC\u06A9\u0646\u062F", composerScrollPadding(142, 420) === 142 + 420 + 10 + 24);
}
console.log("3) \u062A\u06A9\u0633\u062A\u0627\u0631\u06CC\u0627\u06CC \u0628\u0632\u0631\u06AF (\u06A9\u0627\u0645\u067E\u0648\u0632\u0631 \u0628\u0644\u0646\u062F):");
{
  const tall = composerScrollPadding(316, null);
  check("\u06A9\u0627\u0645\u067E\u0648\u0632\u0631 \u0628\u0644\u0646\u062F padding \u0631\u0627 \u0628\u0632\u0631\u06AF \u0645\u06CC\u06A9\u0646\u062F", tall === 316 + 24, tall);
  check("\u06A9\u0627\u0645\u067E\u0648\u0632\u0631 \u0628\u0644\u0646\u062F + \u06A9\u0627\u0631\u062A \u0628\u0627 \u0647\u0645 \u062C\u0645\u0639 \u0645\u06CC\u0634\u0648\u0646\u062F", composerScrollPadding(316, 200) === 316 + 200 + 10 + 24);
}
console.log("4) \u06A9\u0627\u0631\u062A \u0628\u0627 \u0627\u0631\u062A\u0641\u0627\u0639 \u0635\u0641\u0631 \u0645\u062B\u0644 \u0646\u0628\u0648\u062F\u0646 \u06A9\u0627\u0631\u062A \u0631\u0641\u062A\u0627\u0631 \u0645\u06CC\u06A9\u0646\u062F:");
{
  check("cardH=0 \u2192 \u0628\u062F\u0648\u0646 \u0641\u0627\u0635\u0644\u0647 10px", composerScrollPadding(142, 0) === 210);
}
console.log("4\u0628) \u0646\u0648\u0627\u0631 \u06AF\u06CC\u062A \u0628\u0627\u0644\u0627\u06CC \u0627\u06CC\u0646\u067E\u0648\u062A (\u062D\u0627\u0644\u062A \u06A9\u0627\u0645\u067E\u0648\u0632\u0631 + \u0646\u0648\u0627\u0631 \u06AF\u06CC\u062A):");
{
  const withDiff = composerScrollPadding(180, null, 30);
  check("\u0646\u0648\u0627\u0631 \u06AF\u06CC\u062A padding \u0631\u0627 \u0628\u0632\u0631\u06AF \u0645\u06CC\u06A9\u0646\u062F", withDiff === 180 + 30 + 8 + 24, withDiff);
  check("diffBarH \u063A\u0627\u06CC\u0628 \u2192 \u0631\u0641\u062A\u0627\u0631 \u0642\u0628\u0644\u06CC", composerScrollPadding(142, null) === 210);
  check("diffBarH=0 \u2192 \u0628\u062F\u0648\u0646 \u0641\u0627\u0635\u0644\u0647 8px", composerScrollPadding(142, null, 0) === 210);
  check("\u0646\u0648\u0627\u0631 \u06AF\u06CC\u062A + \u06A9\u0627\u0631\u062A \u0628\u0627 \u0647\u0645 \u062C\u0645\u0639 \u0645\u06CC\u0634\u0648\u0646\u062F", composerScrollPadding(142, 200, 30) === 142 + 200 + 10 + 30 + 8 + 24);
  const padding = composerScrollPadding(180, null, 30);
  const floating = 180 + 30 + 8;
  check("\u0622\u0633\u062A\u0627\u0646\u0647 \u0641\u0644\u0634 \u0628\u0627 \u0646\u0648\u0627\u0631 \u06AF\u06CC\u062A \u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A", jumpVisibleThreshold(padding, floating) === padding - floating, jumpVisibleThreshold(padding, floating));
}
console.log("5) \u0622\u0633\u062A\u0627\u0646\u0647\u0654 \u0646\u0645\u0627\u06CC\u0634 \u0641\u0644\u0634 \u067E\u0631\u0634 \u0628\u0647 \u067E\u0627\u06CC\u06CC\u0646 (jumpVisibleThreshold):");
{
  const idle = jumpVisibleThreshold(210, 142);
  check("\u062D\u0627\u0644\u062A \u0639\u0627\u062F\u06CC \u2192 padding \u0645\u0646\u0647\u0627\u06CC \u0627\u0631\u062A\u0641\u0627\u0639 \u06A9\u0627\u0645\u067E\u0648\u0632\u0631", idle === 68, idle);
  const withCard = jumpVisibleThreshold(376, 342);
  check("\u06A9\u0627\u0631\u062A \u0628\u0627\u0632 \u2192 \u0622\u0633\u062A\u0627\u0646\u0647\u0654 \u0628\u0632\u0631\u06AF\u062A\u0631 (\u0645\u062D\u062A\u0648\u0627 \u062F\u06CC\u0631\u062A\u0631 \u067E\u0646\u0647\u0627\u0646 \u0645\u06CC\u0634\u0648\u062F)", withCard === 34, withCard);
  check("\u0647\u0631\u06AF\u0632 \u0645\u0646\u0641\u06CC \u0646\u0645\u06CC\u0634\u0648\u062F", jumpVisibleThreshold(100, 300) === 0);
}
if (failed > 0) {
  console.error(`
\u274C ${failed} \u062A\u0633\u062A \u0646\u0627\u0645\u0648\u0641\u0642`);
  process.exit(1);
}
console.log("\n\u2705 \u0647\u0645\u0647 \u062A\u0633\u062A\u0647\u0627\u06CC scrollPadding \u067E\u0627\u0633 \u0634\u062F\u0646\u062F");
