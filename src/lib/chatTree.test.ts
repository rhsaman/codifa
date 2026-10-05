// Unit tests for the VSCode-like chat split tree (drop positions, resize, normalize).
// Run: npx esbuild src/lib/chatTree.test.ts --bundle --platform=node \
//        --format=esm --outfile=/tmp/chatTree.test.mjs && node /tmp/chatTree.test.mjs
import {
  appendChat,
  buildFromList,
  collectChatIds,
  containsChat,
  dropOnto,
  leafCount,
  normalizeTree,
  removeChat,
  resizePair,
  setNodeSize,
  sizesByChat,
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

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat tree checks passed");
