var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/components/LoadingScreen.tsx
var LoadingScreen_exports = {};
__export(LoadingScreen_exports, {
  LoadingScreen: () => LoadingScreen
});
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
function LoadingScreen({
  error,
  onRetry
}) {
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: "loading-screen",
      role: error ? "alert" : "status",
      "aria-label": error ? "Codifa failed to load" : "Loading Codifa",
      children: [
        /* @__PURE__ */ jsx("div", { className: "loading-screen__glow" }),
        /* @__PURE__ */ jsx("div", { className: "loading-screen__grid" }),
        /* @__PURE__ */ jsxs("div", { className: "loading-screen__content", children: [
          /* @__PURE__ */ jsxs("div", { className: "loading-logo", children: [
            /* @__PURE__ */ jsx("div", { className: "loading-logo__orbit", children: /* @__PURE__ */ jsx("span", { className: "loading-logo__orbit-dot" }) }),
            /* @__PURE__ */ jsx("div", { className: "loading-logo__ring" }),
            /* @__PURE__ */ jsx("div", { className: "loading-logo__core", children: /* @__PURE__ */ jsxs("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round", strokeLinejoin: "round", children: [
              /* @__PURE__ */ jsx("polyline", { points: "16 18 22 12 16 6" }),
              /* @__PURE__ */ jsx("polyline", { points: "8 6 2 12 8 18" })
            ] }) })
          ] }),
          /* @__PURE__ */ jsx("h1", { className: "loading-wordmark", children: "Codifa" }),
          error ? /* @__PURE__ */ jsxs(Fragment, { children: [
            /* @__PURE__ */ jsx("p", { className: "loading-status loading-status--error", children: "Failed to load your data" }),
            /* @__PURE__ */ jsx("p", { className: "load-error-detail", children: error }),
            onRetry && /* @__PURE__ */ jsx("button", { className: "btn", onClick: onRetry, children: "Retry" })
          ] }) : /* @__PURE__ */ jsxs("p", { className: "loading-status", children: [
            /* @__PURE__ */ jsx("span", { className: "loading-status__label", children: "Loading workspace" }),
            /* @__PURE__ */ jsxs("span", { className: "loading-dots", "aria-hidden": "true", children: [
              /* @__PURE__ */ jsx("i", {}),
              /* @__PURE__ */ jsx("i", {}),
              /* @__PURE__ */ jsx("i", {})
            ] })
          ] })
        ] })
      ]
    }
  );
}
var init_LoadingScreen = __esm({
  "src/components/LoadingScreen.tsx"() {
    "use strict";
  }
});

// tests/loadingScreen.ssr.test.tsx
import { jsx as jsx2 } from "react/jsx-runtime";
globalThis.window = {
  addEventListener: () => {
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return void 0;
        return async () => {
        };
      }
    }
  )
};
var { renderToString } = await import("react-dom/server");
var { LoadingScreen: LoadingScreen2 } = await Promise.resolve().then(() => (init_LoadingScreen(), LoadingScreen_exports));
var failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    console.error(`  \u274C ${name}`, extra ?? "");
  }
}
console.log("1) \u062D\u0627\u0644\u062A \u0639\u0627\u062F\u06CC (\u0628\u062F\u0648\u0646 \u062E\u0637\u0627):");
var okHtml = renderToString(/* @__PURE__ */ jsx2(LoadingScreen2, {}));
check("role=status", okHtml.includes('role="status"'));
check("\u0646\u0634\u0627\u0646\u06AF\u0631 \u0644\u0648\u062F\u06CC\u0646\u06AF", okHtml.includes("Loading workspace"));
check("\u0628\u062F\u0648\u0646 \u062F\u06A9\u0645\u0647 Retry", !okHtml.includes("Retry"));
check("\u0628\u062F\u0648\u0646 \u067E\u06CC\u0627\u0645 \u062E\u0637\u0627", !okHtml.includes("Failed to load"));
console.log("2) \u062D\u0627\u0644\u062A \u062E\u0637\u0627 \u0628\u0627 Retry:");
var errHtml = renderToString(
  /* @__PURE__ */ jsx2(LoadingScreen2, { error: "sidecar not reachable", onRetry: () => {
  } })
);
check("role=alert", errHtml.includes('role="alert"'));
check("\u067E\u06CC\u0627\u0645 \u062E\u0637\u0627", errHtml.includes("Failed to load your data"));
check("\u062C\u0632\u0626\u06CC\u0627\u062A \u062E\u0637\u0627", errHtml.includes("sidecar not reachable"));
check("\u062F\u06A9\u0645\u0647 Retry", errHtml.includes("Retry"));
console.log("3) \u062D\u0627\u0644\u062A \u062E\u0637\u0627 \u0628\u062F\u0648\u0646 onRetry \u2192 \u0628\u062F\u0648\u0646 \u062F\u06A9\u0645\u0647:");
var noRetryHtml = renderToString(/* @__PURE__ */ jsx2(LoadingScreen2, { error: "boom" }));
check("\u0628\u062F\u0648\u0646 \u062F\u06A9\u0645\u0647 Retry", !noRetryHtml.includes("Retry"));
if (failed > 0) {
  console.error(`
${failed} \u062A\u0633\u062A \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F \u274C`);
  process.exit(1);
}
console.log("\n\u0647\u0645\u0647 \u062A\u0633\u062A\u0647\u0627 \u067E\u0627\u0633 \u0634\u062F\u0646\u062F \u2705");
