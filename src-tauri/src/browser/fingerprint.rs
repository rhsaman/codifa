use super::*;

/// The WebGL strings the consistency script reports are PLATFORM-specific —
/// a macOS machine claiming an NVIDIA D3D11 renderer would itself be a
/// fingerprint. One plausible per-OS desktop GPU each; the automation browser
/// runs on the user's own hardware, so the real build (GPU enabled) reports
/// the genuine string and this only covers the SwiftShader fallback.
pub(super) fn gl_fingerprint() -> (&'static str, &'static str) {
    if cfg!(target_os = "macos") {
        ("Apple Inc.", "ANGLE Metal Renderer: Apple M1, Unspecified Version")
    } else if cfg!(target_os = "windows") {
        (
            "Google Inc. (Intel)",
            "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A6) Direct3D11 (vs_5_0, ps_5_0), D3D11)",
        )
    } else {
        (
            "Google Inc. (Intel)",
            "ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6 (Core Profile) Mesa 23.2.1)",
        )
    }
}

/// The consistency script with the platform's WebGL strings spliced in.
pub(crate) fn consistency_js() -> String {
    let (vendor, renderer) = gl_fingerprint();
    CONSISTENCY_JS_TEMPLATE
        .replace("__GL_VENDOR__", vendor)
        .replace("__GL_RENDERER__", renderer)
}

/// Injected into every new document of a tab: the places where a headless
/// Chromium differs from the desktop Chrome the User-Agent now claims to be,
/// which sign-in providers (Google's "This browser or app may not be secure"
/// gate above all) probe. Each line is guarded so one failure cannot stop the
/// rest, and none of it changes what the page can do:
///   * `navigator.webdriver` — the automation flag;
///   * `window.chrome` + `app`/`csi`/`loadTimes` — absent in the headless shell;
///   * `navigator.plugins`/`mimeTypes` — a headless shell has none, desktop
///     Chrome always ships the five PDF viewers;
///   * `document.hasFocus` — headless reports false for every document, a
///     clicked-open OAuth popup is focused;
///   * WebGL `UNMASKED_VENDOR/RENDERER` — the shell renders through
///     SwiftShader and says so, which reads as "not a real browser";
///   * `navigator.mediaDevices` — absent in the shell.
pub(super) const CONSISTENCY_JS_TEMPLATE: &str = r#"(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (e) {}
  try {
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {
      PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
      connect: function () { return { onMessage: { addListener: function () {} }, postMessage: function () {}, disconnect: function () {} }; },
      sendMessage: function () {},
    };
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function () {},
        getIsInstalled: function () {},
        installState: function () { return 'not_installed'; },
        runningState: function () { return 'cannot_run'; },
      };
    }
    window.chrome.csi = window.chrome.csi || function () {
      return { startE: Date.now(), onloadT: Date.now(), pageT: Math.round(performance.now()), tran: 15 };
    };
    window.chrome.loadTimes = window.chrome.loadTimes || function () {
      const now = Date.now() / 1000;
      return { requestTime: now, startloadTime: now, commitLoadTime: now, finishDocumentLoadTime: now, finishLoadTime: now, firstPaintTime: now, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: false, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' };
    };
  } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (e) {}
  try {
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const mime = () => ({ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null });
      const make = (name) => {
        const m = mime();
        const p = { name: name, description: 'Portable Document Format', filename: 'internal-pdf-viewer', length: 1, 0: m, item: function () { return m; }, namedItem: function () { return m; } };
        m.enabledPlugin = p;
        return p;
      };
      const list = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'].map(make);
      const plugins = { length: list.length, item: function (i) { return list[i] || null; }, namedItem: function (n) { return list.find(function (p) { return p.name === n; }) || null; }, refresh: function () {} };
      list.forEach(function (p, i) { plugins[i] = p; });
      Object.defineProperty(navigator, 'plugins', { get: function () { return plugins; } });
      const pdf = list[0][0];
      const mimeTypes = { length: 1, 0: pdf, item: function () { return pdf; }, namedItem: function (t) { return t === 'application/pdf' ? pdf : null; } };
      Object.defineProperty(navigator, 'mimeTypes', { get: function () { return mimeTypes; } });
    }
  } catch (e) {}
  try { document.hasFocus = function () { return true; }; } catch (e) {}
  try {
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', { get: function () { return { enumerateDevices: function () { return Promise.resolve([]); } }; } });
    }
  } catch (e) {}
  try {
    const vendor = '__GL_VENDOR__';
    const renderer = '__GL_RENDERER__';
    const patch = function (proto) {
      if (!proto || !proto.getParameter) return;
      const orig = proto.getParameter;
      proto.getParameter = function (p) {
        // Only the SOFTWARE fallback needs covering: when the real GPU stack
        // is up (full build) the genuine vendor/renderer is already the best
        // possible answer and must pass through untouched.
        const v = orig.call(this, p);
        try {
          if (typeof v === 'string' && /swiftshader/i.test(v)) {
            if (p === 37445) return vendor;
            if (p === 37446) return renderer;
          }
        } catch (e) {}
        return v;
      };
    };
    if (window.WebGLRenderingContext) patch(window.WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patch(window.WebGL2RenderingContext.prototype);
  } catch (e) {}
  try {
    if (!window.outerWidth) {
      Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
      Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
    }
  } catch (e) {}
})();"#;

/// `Emulation.setUserAgentOverride` params that make the headless browser
/// present as the ordinary Chrome it is built from.
///
/// A headless Chromium announces itself as `HeadlessChrome` in the User-Agent
/// header AND in the `Sec-CH-UA` client hints, which sites such as Instagram
/// treat as an automated client — a correct login is then answered with the
/// generic "login information is incorrect". Both are rewritten from the
/// browser's own `Browser.getVersion` reply, so the version always matches the
/// binary that is really running. Pure so it is unit-testable.
pub(super) fn ua_override(version: &Value) -> Option<Value> {
    let ua = version["userAgent"].as_str()?;
    // `product` is `HeadlessChrome/140.0.7339.82` (or `Chrome/...`).
    let full = version["product"]
        .as_str()
        .and_then(|p| p.split('/').nth(1))
        .filter(|v| !v.is_empty())?
        .to_string();
    let major = full.split('.').next().unwrap_or_default().to_string();
        let mut params = json!({
            "userAgent": ua.replace("HeadlessChrome", "Chrome"),
            "acceptLanguage": "en-US,en",
        });
        // Client hints describe the OS, so they are only filled in for the platform
        // this build actually runs on; elsewhere the plain UA rewrite is still safe.
        if cfg!(target_os = "macos") {
            params["platform"] = json!("MacIntel");
            let brands = json!([
                {"brand": "Chromium", "version": major},
                {"brand": "Not=A?Brand", "version": "24"},
                {"brand": "Google Chrome", "version": major},
            ]);
            let full_list = json!([
                {"brand": "Chromium", "version": full},
                {"brand": "Not=A?Brand", "version": "24.0.0.0"},
                {"brand": "Google Chrome", "version": full},
            ]);
            params["userAgentMetadata"] = json!({
                "brands": brands,
                "fullVersionList": full_list,
                "fullVersion": full,
                "platform": "macOS",
                "platformVersion": macos_platform_version(),
            "architecture": if cfg!(target_arch = "aarch64") { "arm" } else { "x86" },
            "bitness": "64",
            "model": "",
            "mobile": false,
            "wow64": false,
        });
    }
    Some(params)
}

/// Apply the browser-matched User-Agent to a freshly attached tab session.
/// Best effort: a failure leaves the browser's own identity in place.
pub(super) async fn apply_user_agent(cdp: &mut Cdp, session: &str) {
    if cdp.ua.is_none() {
        // Browser-level call: no session.
        cdp.session = None;
        if let Ok(v) = cdp.send("Browser.getVersion", json!({})).await {
            cdp.ua = ua_override(&v);
        }
    }
    cdp.session = Some(session.to_string());
    // Page domain commands need Page.enable on this session — measured:
    // addScriptToEvaluateOnNewDocument registered WITHOUT it replies fine but
    // never fires, so every new document ran unpatched (UA fix and all).
    let _ = cdp.send("Page.enable", json!({})).await;
    if let Some(params) = cdp.ua.clone() {
        let _ = cdp.send("Emulation.setUserAgentOverride", params).await;
    }
    let _ = cdp
        .send(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source": consistency_js()}),
        )
        .await;
}

