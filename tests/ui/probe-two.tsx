// Throwaway probe (deleted after verification): reproduce the user's exact
// complaint — TWO horizontal bars in the right-docked Review pane. Mounts the
// REAL DiffView (hook on .diff-responsive) INSIDE the Review list (hook on
// .review-files), including a side-by-side toggle which changes the hook's
// signature mid-life.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DiffView } from "../../src/components/ToolCallView";
import { installOverlayScrollbars } from "../../src/lib/useDiffScrollbars";

const body = Array.from({ length: 60 }, (_, i) =>
  `@@ -${i * 3},3 +${i * 3},3 @@\n-const before_${i} = oldFunction("a long string literal that forces the row wide enough to scroll", ${i});\n+const after_${i} = newFunction("a long string literal that forces the row wide enough to scroll", ${i});`,
).join("\n");
const diff = `--- a/src/someModule.test.ts\n+++ b/src/someModule.test.ts\n${body}`;

function Case({ layout }: { layout: "unified" | "side-by-side" }) {
  return (
    <div className="review-diff">
      <DiffView diff={diff} layout={layout} />
    </div>
  );
}

function Harness() {
  const [layout, setLayout] = useState<"unified" | "side-by-side">("unified");
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex" }}>
      <div style={{ flex: 1 }} />
      <div
        className="review-panel"
        style={{ position: "relative", display: "flex", flexDirection: "column" }}
      >
        <div className="review-files" style={{ flex: 1, overflow: "auto", position: "relative" }}>
          <div className="review-file-block">
            <button id="toggle" onClick={() => setLayout(l => l === "unified" ? "side-by-side" : "unified")}>
              toggle
            </button>
            <Case layout={layout} />
          </div>
        </div>
      </div>
    </div>
  );
}

const el = document.createElement("div");
el.id = "two-probe";
document.body.appendChild(el);
createRoot(el).render(<Harness />);
installOverlayScrollbars();
