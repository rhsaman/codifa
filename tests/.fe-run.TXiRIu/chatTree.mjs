// src/lib/chatTree.ts
function nid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function clampSize(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.25, Math.min(4, n));
}
var CHAT_WINDOW_MAX = 6;
function makeLeaf(chatId, size = 1, id) {
  return { kind: "leaf", id: id ?? nid("leaf"), chatId, size: clampSize(size) };
}
function makeSplit(dir, children, size = 1, id) {
  return { kind: "split", id: id ?? nid("split"), dir, size: clampSize(size), children };
}
function dirForPos(pos) {
  if (pos === "left" || pos === "right") return "row";
  if (pos === "top" || pos === "bottom") return "col";
  return null;
}
function beforePos(pos) {
  return pos === "left" || pos === "top";
}
function bestSplitDir(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "row";
  return width >= height ? "row" : "col";
}
function collectChatIds(node) {
  if (!node) return [];
  if (node.kind === "leaf") return [node.chatId];
  const out = [];
  for (const c of node.children) out.push(...collectChatIds(c));
  return out;
}
function leafCount(node) {
  if (!node) return 0;
  if (node.kind === "leaf") return 1;
  return node.children.reduce((n, c) => n + leafCount(c), 0);
}
function containsChat(node, chatId) {
  if (!node) return false;
  if (node.kind === "leaf") return node.chatId === chatId;
  return node.children.some((c) => containsChat(c, chatId));
}
function findLeafByChat(node, chatId) {
  if (!node) return null;
  if (node.kind === "leaf") return node.chatId === chatId ? node : null;
  for (const c of node.children) {
    const hit = findLeafByChat(c, chatId);
    if (hit) return hit;
  }
  return null;
}
function findParent(node, childId) {
  if (!node || node.kind !== "split") return null;
  for (const c of node.children) {
    if (c.id === childId) return node;
    if (c.kind === "split") {
      const hit = findParent(c, childId);
      if (hit) return hit;
    }
  }
  return null;
}
function removeChat(node, chatId) {
  if (!node) return null;
  if (node.kind === "leaf") return node.chatId === chatId ? null : node;
  const children = [];
  let changed = false;
  for (const c of node.children) {
    const next = removeChat(c, chatId);
    if (next) children.push(next);
    if (next !== c) changed = true;
  }
  if (!changed) return node;
  if (children.length === 0) return null;
  return { ...node, children };
}
function swapChats(node, a, b) {
  if (!node) return null;
  if (node.kind === "leaf") {
    if (node.chatId === a) return { ...node, chatId: b };
    if (node.chatId === b) return { ...node, chatId: a };
    return node;
  }
  let changed = false;
  const children = node.children.map((c) => {
    const next = swapChats(c, a, b) ?? c;
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}
function replaceChat(node, targetChatId, nextChatId) {
  if (node.kind === "leaf") {
    return node.chatId === targetChatId ? { ...node, chatId: nextChatId } : node;
  }
  let changed = false;
  const children = node.children.map((c) => {
    const next = replaceChat(c, targetChatId, nextChatId);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}
function normalizeTree(node, validIds, seen = /* @__PURE__ */ new Set()) {
  if (!node) return null;
  if (node.kind === "leaf") {
    if (!validIds.has(node.chatId) || seen.has(node.chatId)) return null;
    seen.add(node.chatId);
    const size = clampSize(node.size);
    return size === node.size ? node : { ...node, size };
  }
  const children = [];
  let changed = false;
  for (const c of node.children) {
    const next = normalizeTree(c, validIds, seen);
    if (next) children.push(next);
    if (next !== c) changed = true;
  }
  if (children.length === 0) return null;
  if (!changed) return node;
  return { ...node, children };
}
function buildFromList(ids, dir, sizes) {
  const clean = [...new Set(ids.filter(Boolean))];
  if (clean.length === 0) return null;
  if (clean.length === 1) return makeLeaf(clean[0], sizes?.[clean[0]] ?? 1);
  return makeSplit(
    dir,
    clean.map((chatId) => makeLeaf(chatId, sizes?.[chatId] ?? 1))
  );
}
function appendChat(node, chatId, dir) {
  if (!node) return makeLeaf(chatId);
  if (containsChat(node, chatId)) return node;
  if (node.kind === "leaf") {
    return makeSplit(dir, [node, makeLeaf(chatId)]);
  }
  return { ...node, children: [...node.children, makeLeaf(chatId)] };
}
function openBeside(node, chatId, targetChatId, dir) {
  if (!node) return makeLeaf(chatId);
  if (containsChat(node, chatId)) return node;
  const fresh = makeLeaf(chatId);
  if (node.kind === "leaf") return makeSplit(dir, [node, fresh]);
  const target = findLeafByChat(node, targetChatId);
  if (!target) {
    if (node.dir === dir) return { ...node, children: [...node.children, fresh] };
    return makeSplit(dir, [node, fresh]);
  }
  const parent = findParent(node, target.id);
  if (parent && parent.dir === dir) {
    const idx = parent.children.findIndex((c) => c.id === target.id);
    const children = parent.children.slice();
    children.splice(idx + 1, 0, fresh);
    return replaceNode(node, parent.id, { ...parent, children });
  }
  return replaceNode(node, target.id, makeSplit(dir, [{ ...target }, fresh]));
}
function dropOnto(root, dragChatId, targetChatId, pos) {
  if (!dragChatId || !targetChatId) return root;
  if (dragChatId === targetChatId) return root;
  if (root && !containsChat(root, dragChatId) && leafCount(root) >= CHAT_WINDOW_MAX && pos !== "center") return root;
  if (pos === "center") {
    if (!root) return makeLeaf(dragChatId);
    if (containsChat(root, dragChatId)) return swapChats(root, dragChatId, targetChatId);
    if (!containsChat(root, targetChatId)) return appendChat(root, dragChatId, "col");
    return replaceChat(root, targetChatId, dragChatId);
  }
  const dirNeeded = dirForPos(pos);
  if (!dirNeeded) return root;
  const before = beforePos(pos);
  if (!root) return makeLeaf(dragChatId);
  const dragLeaf = findLeafByChat(root, dragChatId);
  const targetLeaf = findLeafByChat(root, targetChatId);
  if (dragLeaf && targetLeaf) {
    const pDrag = findParent(root, dragLeaf.id);
    const pTarget = findParent(root, targetLeaf.id);
    if (pDrag && pTarget && pDrag.id === pTarget.id && pDrag.dir === dirNeeded) {
      const rest = pTarget.children.filter((c) => c.id !== dragLeaf.id);
      let dest = rest.findIndex((c) => c.id === targetLeaf.id) + (before ? 0 : 1);
      dest = Math.max(0, Math.min(rest.length, dest));
      const reordered = rest.slice();
      reordered.splice(dest, 0, dragLeaf);
      return replaceNode(root, pTarget.id, { ...pTarget, children: reordered });
    }
  }
  const dragSize = dragLeaf?.size ?? 1;
  const base = containsChat(root, dragChatId) ? removeChat(root, dragChatId) : root;
  if (!base) return makeLeaf(dragChatId, dragSize);
  const target = findLeafByChat(base, targetChatId);
  if (!target) return appendChat(base, dragChatId, dirNeeded);
  const fresh = makeLeaf(dragChatId, dragSize);
  const parent = findParent(base, target.id);
  if (parent && parent.dir === dirNeeded) {
    const idx = parent.children.findIndex((c) => c.id === target.id);
    const children = parent.children.slice();
    children.splice(before ? idx : idx + 1, 0, fresh);
    return replaceNode(base, parent.id, { ...parent, children });
  }
  const split = makeSplit(
    dirNeeded,
    before ? [fresh, { ...target }] : [{ ...target }, fresh],
    target.size
  );
  split.children[0].size = 1;
  split.children[1].size = 1;
  return replaceNode(base, target.id, split);
}
function dropOntoRoot(root, dragChatId, pos) {
  if (!dragChatId) return root;
  const dirNeeded = dirForPos(pos);
  if (!dirNeeded) return root;
  const before = beforePos(pos);
  if (!root) return makeLeaf(dragChatId);
  const dragLeaf = findLeafByChat(root, dragChatId);
  const dragSize = dragLeaf?.size ?? 1;
  if (dragLeaf) {
    if (leafCount(root) <= 1) return root;
    const base = removeChat(root, dragChatId);
    if (!base) return makeLeaf(dragChatId, dragSize);
    const fresh2 = makeLeaf(dragChatId, dragSize);
    if (base.kind === "split" && base.dir === dirNeeded) {
      const children = before ? [fresh2, ...base.children] : [...base.children, fresh2];
      return { ...base, children };
    }
    return makeSplit(dirNeeded, before ? [fresh2, base] : [base, fresh2]);
  }
  if (leafCount(root) >= CHAT_WINDOW_MAX) return root;
  const fresh = makeLeaf(dragChatId);
  if (root.kind === "split" && root.dir === dirNeeded) {
    const children = before ? [fresh, ...root.children] : [...root.children, fresh];
    return { ...root, children };
  }
  return makeSplit(dirNeeded, before ? [fresh, root] : [root, fresh]);
}
function replaceNode(node, id, next) {
  if (node.id === id) return next;
  if (node.kind === "leaf") return node;
  let changed = false;
  const children = node.children.map((c) => {
    const r = replaceNode(c, id, next);
    if (r !== c) changed = true;
    return r;
  });
  return changed ? { ...node, children } : node;
}
function setNodeSize(node, id, size) {
  if (!node) return null;
  if (node.id === id) return { ...node, size: clampSize(size) };
  if (node.kind === "leaf") return node;
  let changed = false;
  const children = node.children.map((c) => {
    const next = setNodeSize(c, id, size);
    if (next && next !== c) changed = true;
    return next ?? c;
  });
  return changed ? { ...node, children } : node;
}
function resizePair(node, parentId, firstId, secondId, firstSize, secondSize) {
  const step = setNodeSize(node, firstId, firstSize);
  return setNodeSize(step, secondId, secondSize);
}
function sizesByChat(node) {
  const out = {};
  const walk = (n) => {
    if (!n) return;
    if (n.kind === "leaf") out[n.chatId] = clampSize(n.size);
    else n.children.forEach(walk);
  };
  walk(node);
  return out;
}
function toggleFullscreenId(current, target) {
  if (!target) return current;
  return current === target ? null : target;
}
function isVacatedByDrag(childChatIds, dragId) {
  if (!dragId) return false;
  return childChatIds.length === 1 && childChatIds[0] === dragId;
}
function ghostInsertIndex(targetIndex, pos) {
  return beforePos(pos) ? targetIndex : targetIndex + 1;
}
function shouldShowSiblingGhost(parentDir, pos, isDirectChild) {
  if (!isDirectChild) return false;
  if (pos === "center") return false;
  return dirForPos(pos) === parentDir;
}
function resolveLeafPos(x, y, prev) {
  const enter = 0.25;
  const exit = 0.34;
  const lx = prev === "left" ? exit : enter;
  const rx = prev === "right" ? 1 - exit : 1 - enter;
  const ty = prev === "top" ? exit : enter;
  const by = prev === "bottom" ? 1 - exit : 1 - enter;
  if (x < lx && x <= y && x <= 1 - y) return "left";
  if (x > rx && x >= y && x >= 1 - y) return "right";
  if (y < ty) return "top";
  if (y > by) return "bottom";
  return "center";
}
function shouldShowNestedGhost(parentDir, pos, isDirectChild) {
  if (!isDirectChild) return false;
  if (pos === "center") return false;
  const need = dirForPos(pos);
  if (!need) return false;
  return need !== parentDir;
}

// src/lib/chatTree.test.ts
var failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`, extra ?? "");
  }
}
console.log("1) dropOnto \u2014 edges split in any direction, center swaps:");
{
  const root = buildFromList(["a", "b"], "col");
  const left = dropOnto(root, "c", "b", "left");
  check("left drop keeps all chats", JSON.stringify(collectChatIds(left)) === JSON.stringify(["a", "c", "b"]));
  check("left drop creates a row split", left?.kind === "split");
  const bottom = dropOnto(root, "c", "a", "bottom");
  check("bottom drop keeps order", JSON.stringify(collectChatIds(bottom)) === JSON.stringify(["a", "c", "b"]));
  const swapped = dropOnto(root, "a", "b", "center");
  check("center drop swaps visible leaves", JSON.stringify(collectChatIds(swapped)) === JSON.stringify(["b", "a"]));
  check("self drop is a no-op", dropOnto(root, "a", "a", "left") === root);
}
console.log("2) dropOnto \u2014 horizontal row still accepts vertical drops and vice versa:");
{
  const row = buildFromList(["a", "b"], "row");
  const viaTop = dropOnto(row, "c", "a", "top");
  check("row accepts top drop", collectChatIds(viaTop).join(",") === "c,a,b");
  const col = buildFromList(["a", "b"], "col");
  const viaRight = dropOnto(col, "c", "b", "right");
  check("col accepts right drop", collectChatIds(viaRight).join(",") === "a,b,c");
  const nested = dropOnto(viaRight, "d", "a", "bottom");
  check("free arrangement keeps every chat", collectChatIds(nested).join(",") === "a,d,b,c");
  check("leaf count tracks windows", leafCount(nested) === 4);
}
console.log("3) removeChat \u2014 collapses single-child splits, appendChat dedupes:");
{
  const root = buildFromList(["a", "b", "c"], "row");
  const pruned = removeChat(root, "b");
  check("remove drops the chat", JSON.stringify(collectChatIds(pruned)) === JSON.stringify(["a", "c"]));
  const appended = appendChat(pruned, "a", "row");
  check("append dedupes existing chat", appended === pruned);
  const grown = appendChat(pruned, "d", "row");
  check("append adds new chat", JSON.stringify(collectChatIds(grown)) === JSON.stringify(["a", "c", "d"]));
  check("contains finds nested chat", containsChat(grown, "d") && !containsChat(grown, "zx"));
}
console.log("4) resize + normalize \u2014 sizes clamp, unknown ids drop:");
{
  let a02 = function() {
    return "a";
  };
  a0 = a02;
  const root = buildFromList(["a", "b"], "row", { a: 2, b: 1 });
  check("sizes mirror per-chat", sizesByChat(root).a === 2 && sizesByChat(root).b === 1);
  const splitId = root.kind === "split" ? root.id : "";
  const firstId = root.kind === "split" ? root.children[0].id : "";
  const secondId = root.kind === "split" ? root.children[1].id : "";
  const resized = resizePair(root, splitId, firstId, secondId, 3, 0.1);
  const sizes = sizesByChat(resized);
  check("resize clamps into [0.25, 4]", sizes.a === 3 && sizes.b === 0.25, sizes);
  const single = setNodeSize(root, firstId, 10);
  check("single size clamps to 4", sizesByChat(single)[a02()] === 4);
  const valid = /* @__PURE__ */ new Set(["a"]);
  const cleaned = normalizeTree(root, valid);
  check("normalize drops unknown chats", JSON.stringify(collectChatIds(cleaned)) === JSON.stringify(["a"]));
  check("normalize empty -> null", normalizeTree(root, /* @__PURE__ */ new Set()) === null);
}
var a0;
console.log("5) toggleFullscreenId \u2014 window fullscreen toggle is idempotent:");
{
  check("off + a -> a", toggleFullscreenId(null, "a") === "a");
  check("a + a -> off", toggleFullscreenId("a", "a") === null);
  check("a + b -> b", toggleFullscreenId("a", "b") === "b");
  check("empty target keeps current", toggleFullscreenId("a", "") === "a");
}
console.log("6) dropOntoRoot \u2014 dragged window space counts as empty:");
{
  const nested = buildFromList(["a", "b", "c"], "row");
  const moved = dropOntoRoot(nested, "c", "bottom");
  check("root bottom keeps all chats", JSON.stringify(collectChatIds(moved)) === JSON.stringify(["a", "b", "c"]));
  check("root bottom puts dragged pane last full-width", moved?.kind === "split" && moved.children[1].chatId === "c");
  const single = buildFromList(["a"], "row");
  check("root drop on single window is a no-op", dropOntoRoot(single, "a", "bottom") === single);
  const row = buildFromList(["a", "b"], "row");
  const layout = dropOnto(row, "c", "b", "bottom");
  check("nested layout keeps every chat", collectChatIds(layout).join(",") === "a,b,c");
  const landed = dropOntoRoot(layout, "c", "bottom");
  check("nested root bottom keeps order", collectChatIds(landed).join(",") === "a,b,c");
  check(
    "nested root bottom puts dragged pane full-width below",
    landed.kind === "split" && landed.dir === "col" && landed.children.length === 2 && landed.children[1].chatId === "c" && collectChatIds(landed.children[0]).join(",") === "a,b",
    landed
  );
}
console.log("7) normalizeTree \u2014 nested duplicate chat renders once:");
{
  const dup = makeSplit("row", [makeLeaf("a"), makeSplit("col", [makeLeaf("a"), makeLeaf("b")])]);
  const cleaned = normalizeTree(dup, /* @__PURE__ */ new Set(["a", "b"]));
  check("duplicate across splits collapses to one window per chat", JSON.stringify(collectChatIds(cleaned)) === JSON.stringify(["a", "b"]), cleaned);
}
console.log("8) appendChat never replaces + bestSplitDir follows aspect:");
{
  const full = buildFromList(["a", "b", "c", "d"], "row");
  const grown = appendChat(full, "e", "row");
  check("explicit open adds a fifth window instead of replacing", JSON.stringify(collectChatIds(grown)) === JSON.stringify(["a", "b", "c", "d", "e"]));
  check("wide container splits side-by-side", bestSplitDir(1600, 900) === "row");
  check("tall container stacks", bestSplitDir(800, 1200) === "col");
}
console.log("9) openBeside \u2014 new window opens next to focus, never replaces:");
{
  const row = buildFromList(["a", "b"], "row");
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
console.log("10) placement contract \u2014 drag/new-chat adds, click+select replaces:");
{
  const row = buildFromList(["a", "b"], "row");
  const added = openBeside(row, "c", "b", "row");
  check("new chat adds a window", JSON.stringify(collectChatIds(added)) === JSON.stringify(["a", "b", "c"]));
  const replaced = replaceChat(row, "b", "c");
  check("click+select replaces clicked window", JSON.stringify(collectChatIds(replaced)) === JSON.stringify(["a", "c"]));
  const external = openBeside(row, "c", "b", "col");
  check("external drag creates new window", leafCount(external) === 3);
}
console.log("11) normalizeTree \u2014 identity-stable when nothing changes:");
{
  const root = buildFromList(["a", "b"], "row");
  const same = normalizeTree(root, /* @__PURE__ */ new Set(["a", "b"]));
  check("clean tree keeps reference (no extra render after minimize)", same === root);
  const leaf = makeLeaf("a");
  const sameLeaf = normalizeTree(leaf, /* @__PURE__ */ new Set(["a"]));
  check("clean leaf keeps reference", sameLeaf === leaf);
}
console.log("12) minimize preserves instances \u2014 no collapse on remove/normalize:");
{
  const root = buildFromList(["a", "b"], "row");
  const leafA = root.children[0];
  const pruned = removeChat(root, "b");
  check("remove keeps split wrapper (no collapse)", pruned !== null && pruned.kind === "split" && pruned.children.length === 1);
  check("remove keeps root id", pruned !== null && root.id === pruned.id);
  check("remaining leaf keeps reference (no remount)", pruned !== null && pruned.children[0] === leafA);
  check("remaining ids correct", JSON.stringify(collectChatIds(pruned)) === JSON.stringify(["a"]));
  const leafC = makeLeaf("c");
  const nested = makeSplit("row", [makeLeaf("a"), makeSplit("col", [makeLeaf("b"), leafC])]);
  const prunedNested = removeChat(nested, "b");
  const midAfter = prunedNested !== null && prunedNested.kind === "split" ? prunedNested.children[1] : null;
  check("nested single-child split kept", midAfter !== null && midAfter.kind === "split" && midAfter.children.length === 1);
  check(
    "nested remaining leaf keeps reference",
    midAfter !== null && midAfter.kind === "split" && midAfter.children[0] === leafC
  );
  const singleSplit = makeSplit("row", [makeLeaf("a")]);
  check("normalize keeps single-child split reference", normalizeTree(singleSplit, /* @__PURE__ */ new Set(["a"])) === singleSplit);
}
console.log("13) isVacatedByDrag \u2014 dragged slot counts as empty:");
{
  check("source leaf vacates", isVacatedByDrag(["b"], "b"));
  check("other leaf stays", !isVacatedByDrag(["a"], "b"));
  check("mixed subtree stays", !isVacatedByDrag(["a", "b"], "b"));
  check("external drag never vacates", !isVacatedByDrag(["b"], null));
}
console.log("14) sibling ghost \u2014 edge drop along axis shows equal panes:");
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
console.log("15) resolveLeafPos \u2014 hysteresis stops edge/center flicker:");
{
  check("enters left past edge", resolveLeafPos(0.2, 0.5, null) === "left");
  check("stays left on small drift", resolveLeafPos(0.3, 0.5, "left") === "left");
  check("leaves left past exit band", resolveLeafPos(0.4, 0.5, "left") === "center");
  check("center stays center", resolveLeafPos(0.3, 0.5, null) === "center");
}
console.log("16) six-window max \u2014 reorder/swap/replace work, edge add blocked:");
{
  const six = buildFromList(["a", "b", "c", "d", "e", "f"], "row");
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
  console.error(`
${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat tree checks passed");
