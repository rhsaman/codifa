// Unit tests for the VSCode-like chat split tree (drop positions, resize, normalize).
// Run: npx esbuild src/lib/chatTree.test.ts --bundle --platform=node \
//        --format=esm --outfile=/tmp/chatTree.test.mjs && node /tmp/chatTree.test.mjs
import {
  appendChat,
  bestSplitDir,
  buildFromList,
  collectChatIds,
  containsChat,
  dropOnto,
  dropOntoRoot,
  ghostInsertIndex,
  isVacatedByDrag,
  leafCount,
  makeLeaf,
  makeSplit,
  normalizeTree,
  openBeside,
  removeChat,
  replaceChat,
  resizePair,
  setNodeSize,
  resolveLeafPos,
  shouldShowNestedGhost,
  shouldShowSiblingGhost,
  sizesByChat,
  toggleFullscreenId,
} from "./chatTree";

export {};

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`, extra ?? "");
  }
}

console.log("1) dropOnto — edges split in any direction, center swaps:");
{
  const root = buildFromList(["a", "b"], "col")!;
  const left = dropOnto(root, "c", "b", "left");
  check("left drop keeps all chats", JSON.stringify(collectChatIds(left)) === JSON.stringify(["a", "c", "b"]));
  check("left drop creates a row split", left?.kind === "split");
  const bottom = dropOnto(root, "c", "a", "bottom");
  check("bottom drop keeps order", JSON.stringify(collectChatIds(bottom)) === JSON.stringify(["a", "c", "b"]));
  const swapped = dropOnto(root, "a", "b", "center");
  check("center drop swaps visible leaves", JSON.stringify(collectChatIds(swapped)) === JSON.stringify(["b", "a"]));
  check("self drop is a no-op", dropOnto(root, "a", "a", "left") === root);
}

console.log("2) dropOnto — horizontal row still accepts vertical drops and vice versa:");
{
  const row = buildFromList(["a", "b"], "row")!;
  const viaTop = dropOnto(row, "c", "a", "top");
  check("row accepts top drop", collectChatIds(viaTop).join(",") === "c,a,b");
  const col = buildFromList(["a", "b"], "col")!;
  const viaRight = dropOnto(col, "c", "b", "right");
  check("col accepts right drop", collectChatIds(viaRight).join(",") === "a,b,c");
  const nested = dropOnto(viaRight, "d", "a", "bottom");
  check("free arrangement keeps every chat", collectChatIds(nested).join(",") === "a,d,b,c");
  check("leaf count tracks windows", leafCount(nested) === 4);
}

console.log("3) removeChat — collapses single-child splits, appendChat dedupes:");
{
  const root = buildFromList(["a", "b", "c"], "row")!;
  const pruned = removeChat(root, "b");
  check("remove drops the chat", JSON.stringify(collectChatIds(pruned)) === JSON.stringify(["a", "c"]));
  const appended = appendChat(pruned, "a", "row");
  check("append dedupes existing chat", appended === pruned);
  const grown = appendChat(pruned, "d", "row");
  check("append adds new chat", JSON.stringify(collectChatIds(grown)) === JSON.stringify(["a", "c", "d"]));
  check("contains finds nested chat", containsChat(grown, "d") && !containsChat(grown, "zx"));
}

console.log("4) resize + normalize — sizes clamp, unknown ids drop:");
{
  const root = buildFromList(["a", "b"], "row", { a: 2, b: 1 })!;
  check("sizes mirror per-chat", sizesByChat(root).a === 2 && sizesByChat(root).b === 1);
  const splitId = root.kind === "split" ? root.id : "";
  const firstId = root.kind === "split" ? root.children[0].id : "";
  const secondId = root.kind === "split" ? root.children[1].id : "";
  const resized = resizePair(root, splitId, firstId, secondId, 3, 0.1);
  const sizes = sizesByChat(resized);
  check("resize clamps into [0.25, 4]", sizes.a === 3 && sizes.b === 0.25, sizes);
  const single = setNodeSize(root, firstId, 10);
  check("single size clamps to 4", sizesByChat(single)[a0()] === 4);
  const valid = new Set(["a"]);
  const cleaned = normalizeTree(root, valid);
  check("normalize drops unknown chats", JSON.stringify(collectChatIds(cleaned)) === JSON.stringify(["a"]));
  check("normalize empty -> null", normalizeTree(root, new Set()) === null);
  function a0(): string {
    return "a";
  }
}

console.log("5) toggleFullscreenId — window fullscreen toggle is idempotent:");
{
  check("off + a -> a", toggleFullscreenId(null, "a") === "a");
  check("a + a -> off", toggleFullscreenId("a", "a") === null);
  check("a + b -> b", toggleFullscreenId("a", "b") === "b");
  check("empty target keeps current", toggleFullscreenId("a", "") === "a");
}

console.log("6) dropOntoRoot — dragged window space counts as empty:");
{
  const nested = buildFromList(["a", "b", "c"], "row")!;
  const moved = dropOntoRoot(nested, "c", "bottom");
  check("root bottom keeps all chats", JSON.stringify(collectChatIds(moved)) === JSON.stringify(["a", "b", "c"]));
  check("root bottom puts dragged pane last full-width", moved?.kind === "split" && (moved.children[1] as { chatId?: string }).chatId === "c");
  const single = buildFromList(["a"], "row")!;
  check("root drop on single window is a no-op", dropOntoRoot(single, "a", "bottom") === single);
  // User scenario: row [left, col [topRight, bottomRight]], drag the
  // bottom-right pane to the bottom edge -> col [row [left, topRight],
  // dragged] so the dragged pane lands full-width below.
  const row = buildFromList(["a", "b"], "row")!;
  const layout = dropOnto(row, "c", "b", "bottom")!;
  check("nested layout keeps every chat", collectChatIds(layout).join(",") === "a,b,c");
  const landed = dropOntoRoot(layout, "c", "bottom")!;
  check("nested root bottom keeps order", collectChatIds(landed).join(",") === "a,b,c");
  check(
    "nested root bottom puts dragged pane full-width below",
    landed.kind === "split" &&
      landed.dir === "col" &&
      landed.children.length === 2 &&
      (landed.children[1] as { chatId?: string }).chatId === "c" &&
      collectChatIds(landed.children[0]).join(",") === "a,b",
    landed,
  );
}

console.log("7) normalizeTree — nested duplicate chat renders once:");
{
  const dup = makeSplit("row", [makeLeaf("a"), makeSplit("col", [makeLeaf("a"), makeLeaf("b")])]) as never as Parameters<typeof normalizeTree>[0];
  const cleaned = normalizeTree(dup, new Set(["a", "b"]));
  check("duplicate across splits collapses to one window per chat", JSON.stringify(collectChatIds(cleaned)) === JSON.stringify(["a", "b"]), cleaned);
}

console.log("8) appendChat never replaces + bestSplitDir follows aspect:");
{
  const full = buildFromList(["a", "b", "c", "d"], "row")!;
  const grown = appendChat(full, "e", "row");
  check("explicit open adds a fifth window instead of replacing", JSON.stringify(collectChatIds(grown)) === JSON.stringify(["a", "b", "c", "d", "e"]));
  check("wide container splits side-by-side", bestSplitDir(1600, 900) === "row");
  check("tall container stacks", bestSplitDir(800, 1200) === "col");
}

console.log("9) openBeside — new window opens next to focus, never replaces:");
{
  const row = buildFromList(["a", "b"], "row")!;
  const tall = openBeside(row, "c", "b", "col");
  check("beside split keeps every chat", collectChatIds(tall).join(",") === "a,b,c");
  const second = tall.kind === "split" ? tall.children[1] : null;
  check("different axis splits only the focused leaf", second !== null && second.kind === "split" && second.dir === "col" && collectChatIds(second).join(",") === "b,c");
  const wide = openBeside(row, "c", "a", "row");
  check("same axis extends without nesting", wide.kind === "split" && wide.dir === "row" && collectChatIds(wide).join(",") === "a,c,b");
  check("existing chat is a no-op", openBeside(row, "a", "b", "row") === row);
  const replaced = replaceChat(row, "b", "c");
  check("replace swaps the clicked window", JSON.stringify(collectChatIds(replaced)) === JSON.stringify(["a", "c"]));
  check("replace keeps sizes", sizesByChat(replaced).a === 1 && sizesByChat(replaced).c === 1);
}

console.log("10) placement contract — drag/new-chat adds, click+select replaces:");
{
  const row = buildFromList(["a", "b"], "row")!;
  // New chat (+) always opens beside focus, never replaces.
  const added = openBeside(row, "c", "b", "row");
  check("new chat adds a window", JSON.stringify(collectChatIds(added)) === JSON.stringify(["a", "b", "c"]));
  // Click on window b then select c from tab/sidebar replaces b.
  const replaced = replaceChat(row, "b", "c");
  check("click+select replaces clicked window", JSON.stringify(collectChatIds(replaced)) === JSON.stringify(["a", "c"]));
  // External drag onto center must add, not replace (store routes it via openBeside).
  const external = openBeside(row, "c", "b", "col");
  check("external drag creates new window", leafCount(external) === 3);
}

console.log("11) normalizeTree — identity-stable when nothing changes:");
{
  const root = buildFromList(["a", "b"], "row")!;
  const same = normalizeTree(root, new Set(["a", "b"]));
  check("clean tree keeps reference (no extra render after minimize)", same === root);
  const leaf = makeLeaf("a");
  const sameLeaf = normalizeTree(leaf, new Set(["a"]));
  check("clean leaf keeps reference", sameLeaf === leaf);
}

console.log("12) minimize preserves instances — no collapse on remove/normalize:");
{
  const root = buildFromList(["a", "b"], "row")!;
  const leafA = (root as unknown as { children: unknown[] }).children[0];
  const pruned = removeChat(root, "b") as unknown as { kind: string; id: string; children: unknown[] } | null;
  check("remove keeps split wrapper (no collapse)", pruned !== null && pruned.kind === "split" && pruned.children.length === 1);
  check("remove keeps root id", pruned !== null && (root as unknown as { id: string }).id === pruned.id);
  check("remaining leaf keeps reference (no remount)", pruned !== null && pruned.children[0] === leafA);
  check("remaining ids correct", JSON.stringify(collectChatIds(pruned as never)) === JSON.stringify(["a"]));
  const leafC = makeLeaf("c");
  const nested = makeSplit("row", [makeLeaf("a"), makeSplit("col", [makeLeaf("b"), leafC])]);
  const prunedNested = removeChat(nested, "b") as unknown as { kind: string; children: Array<{ kind: string; children: unknown[] }> } | null;
  const midAfter = prunedNested !== null && prunedNested.kind === "split" ? prunedNested.children[1] : null;
  check("nested single-child split kept", midAfter !== null && midAfter.kind === "split" && midAfter.children.length === 1);
  check(
    "nested remaining leaf keeps reference",
    midAfter !== null && midAfter.kind === "split" && (midAfter as unknown as { children: unknown[] }).children[0] === leafC,
  );
  const singleSplit = makeSplit("row", [makeLeaf("a")]);
  check("normalize keeps single-child split reference", normalizeTree(singleSplit, new Set(["a"])) === singleSplit);
}

console.log("13) isVacatedByDrag — dragged slot counts as empty:");
{
  check("source leaf vacates", isVacatedByDrag(["b"], "b"));
  check("other leaf stays", !isVacatedByDrag(["a"], "b"));
  check("mixed subtree stays", !isVacatedByDrag(["a", "b"], "b"));
  check("external drag never vacates", !isVacatedByDrag(["b"], null));
}

console.log("14) sibling ghost — edge drop along axis shows equal panes:");
{
  check("row + right on direct child ghosts", shouldShowSiblingGhost("row", "right", true));
  check("row + bottom stays overlay", !shouldShowSiblingGhost("row", "bottom", true));
  check("center never ghosts", !shouldShowSiblingGhost("row", "center", true));
  check("nested target stays overlay", !shouldShowSiblingGhost("row", "right", false));
  check("right inserts after target", ghostInsertIndex(1, "right") === 2);
  check("left inserts before target", ghostInsertIndex(1, "left") === 1);
  check("row + bottom nests across axis", shouldShowNestedGhost("row", "bottom", true));
  check("row + right never nests along axis", !shouldShowNestedGhost("row", "right", true));
}

console.log("15) resolveLeafPos — hysteresis stops edge/center flicker:");
{
  check("enters left past edge", resolveLeafPos(0.2, 0.5, null) === "left");
  check("stays left on small drift", resolveLeafPos(0.3, 0.5, "left") === "left");
  check("leaves left past exit band", resolveLeafPos(0.4, 0.5, "left") === "center");
  check("center stays center", resolveLeafPos(0.3, 0.5, null) === "center");
}

console.log("16) six-window max — reorder/swap/replace work, edge add blocked:");
{
  const six = buildFromList(["a", "b", "c", "d", "e", "f"], "row")!;
  check("six leaves", leafCount(six) === 6);
  const reordered = dropOnto(six, "f", "a", "left");
  check("internal edge reorder keeps six", leafCount(reordered) === 6 && JSON.stringify(collectChatIds(reordered)) === JSON.stringify(["f", "a", "b", "c", "d", "e"]));
  const swapped = dropOnto(six, "a", "b", "center");
  check("internal center swaps", JSON.stringify(collectChatIds(swapped)) === JSON.stringify(["b", "a", "c", "d", "e", "f"]));
  const blocked = dropOnto(six, "g", "a", "left");
  check("external edge blocked at max", blocked === six);
  const replaced = dropOnto(six, "g", "b", "center");
  check("external center replaces at max", JSON.stringify(collectChatIds(replaced)) === JSON.stringify(["a", "g", "c", "d", "e", "f"]) && leafCount(replaced) === 6);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat tree checks passed");
