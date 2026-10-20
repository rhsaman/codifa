//! Native browser driver — the CDP layer the agent calls as tools.
//!
//! `browser.rs` already speaks CDP, but only request/reply on a socket it opens
//! and drops per call: it throws events away, cannot wait for a page to settle,
//! and has no notion of an element. That is enough to mirror a page as JPEG
//! frames, and not enough to drive one. This module adds the missing half:
//!
//! * ONE long-lived WebSocket per chat, with a writer task and a reader loop, so
//!   events (`Page.loadEventFired`, `Runtime.consoleAPICalled`,
//!   `Network.responseReceived`, `Page.javascriptDialogOpening`) actually arrive.
//! * A SNAPSHOT of the page as a compact list of `[ref] role "name"` entries.
//!   Refs are `(role, name, occurrence)` triples, so they survive scrolling and
//!   layout shifts instead of being dead pixel coordinates.
//! * Element actions resolved through the DOM (`DOM.scrollIntoViewIfNeeded` then
//!   a real mouse event at the element's centre), which is what makes click/type
//!   reliable on a page we have never seen.
//!
//! It deliberately reuses the shared Chromium owned by `browser.rs` (through
//! `driver_hooks`): the agent and the right-side panel drive the SAME tab, so
//! the user always sees what the agent is doing.
//!
//! Everything here is synchronous. The callers are the tool dispatcher (a
//! blocking thread) and the axum handlers (which call into it via
//! `spawn_blocking`), so a blocking API keeps the two paths identical.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender as Waiter;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use crate::browser::driver_hooks as hooks;

/// Per-command timeout. Generous enough for a heavy `Runtime.evaluate`,
/// short enough that a wedged renderer cannot hang a turn.
const CDP_CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a navigation may take to reach `load`.
const NAV_TIMEOUT: Duration = Duration::from_secs(30);
/// How many past snapshots keep their refs resolvable.
const MAX_SNAPSHOTS: usize = 24;
/// Cap on the text handed back to the model for one snapshot.
const SNAPSHOT_MAX_CHARS: usize = 12_000;
/// Cap on the captured console / network buffers (per chat).
const LOG_CAP: usize = 200;
const NET_CAP: usize = 300;
/// Fire-and-forget CDP id: replies to it are dropped on the floor.
const NO_REPLY_ID: u64 = 0;

// ---------------------------------------------------------------------------
// Injected page helpers
// ---------------------------------------------------------------------------

/// DOM helpers injected into the page for every snapshot and every element
/// action, so the role/name a ref points at is computed by exactly ONE piece of
/// code — the snapshot that printed the ref and the click that follows it can
/// never disagree about what "button Save" is.
const JS_HELPERS: &str = r#"
function __cfText(el){
  var t=(el.innerText||el.textContent||'');
  t=t.replace(/\s+/g,' ').trim();
  return t.length>120?t.slice(0,120)+'…':t;
}
function __cfLabel(el){
  if(!el||!el.getAttribute) return '';
  var al=el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||el.getAttribute('alt');
  if(al) return al.replace(/\s+/g,' ').trim();
  var tag=el.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'){
    var v=(el.value||'').replace(/\s+/g,' ').trim();
    if(v) return v.slice(0,60);
  }
  return __cfText(el);
}
function __cfRole(el){
  var r=((el.getAttribute&&el.getAttribute('role'))||'').toLowerCase();
  if(r) return r;
  var tag=el.tagName;
  if(tag==='A') return 'link';
  if(tag==='BUTTON') return 'button';
  if(tag==='INPUT') return (el.type||'input').toLowerCase();
  if(tag==='TEXTAREA') return 'textbox';
  if(tag==='SELECT') return 'combobox';
  if(tag==='SUMMARY') return 'summary';
  return tag.toLowerCase();
}
function __cfVisible(el){
  if(!el||!el.getBoundingClientRect) return false;
  var r=el.getBoundingClientRect();
  if(r.width<=0||r.height<=0) return false;
  var st=getComputedStyle(el);
  if(st.visibility==='hidden'||st.display==='none') return false;
  if(st.opacity==='0') return false;
  return true;
}
var __CF_SEL='a,button,input,textarea,select,summary,[role],[onclick],[contenteditable="true"],[tabindex]';
function __cfCandidates(){
  var out=[],seen={},list=document.querySelectorAll(__CF_SEL),i;
  for(i=0;i<list.length&&i<3000;i++){
    var el=list[i];
    if(!__cfVisible(el)) continue;
    var role=__cfRole(el);
    if(role==='presentation'||role==='none'||role==='generic') continue;
    var name=__cfLabel(el);
    var r=el.getBoundingClientRect();
    var key=role+'\u0000'+name+'\u0000'+Math.round(r.left)+','+Math.round(r.top);
    if(seen[key]) continue;
    seen[key]=1;
    out.push({el:el,role:role,name:name,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});
  }
  return out;
}
function __cfMatch(role,name,nth){
  nth=nth||0;
  var list=__cfCandidates(),hits=[],i;
  for(i=0;i<list.length;i++){ if(list[i].role===role&&list[i].name===name) hits.push(list[i].el); }
  if(hits.length>nth) return hits[nth];
  hits=[];
  for(i=0;i<list.length;i++){
    if(list[i].role===role&&(list[i].name.indexOf(name)>=0||name.indexOf(list[i].name)>=0)) hits.push(list[i].el);
  }
  if(hits.length>nth) return hits[nth];
  if(hits.length) return hits[0];
  hits=[];
  for(i=0;i<list.length;i++){ if(list[i].name.indexOf(name)>=0) hits.push(list[i].el); }
  return hits.length?hits[Math.min(nth,hits.length-1)]:null;
}
"#;

/// Wraps an expression so the helpers above are in scope.
fn js(expr: &str) -> String {
    format!("(function(){{{JS_HELPERS}\nreturn ({expr});}})()")
}

/// Snapshot expression: the interactive entries, the headings, and the page text.
fn js_snapshot() -> String {
    format!(
        r#"(function(){{{JS_HELPERS}
var cands=__cfCandidates(),entries=[],i;
for(i=0;i<cands.length&&entries.length<400;i++){{
  entries.push({{role:cands[i].role,name:cands[i].name,x:cands[i].x,y:cands[i].y}});
}}
var heads=document.querySelectorAll('h1,h2,h3,h4,h5,h6'),h=[],hc=0;
for(i=0;i<heads.length&&hc<100;i++){{
  if(!__cfVisible(heads[i])) continue;
  var t=__cfText(heads[i]);
  if(!t) continue;
  h.push({{role:heads[i].tagName.toLowerCase(),name:t}});
  hc++;
}}
var body=document.body?((document.body.innerText||'')):'';
body=body.replace(/[ \t]+/g,' ').replace(/\n{{3,}}/g,'\n\n').trim();
return {{url:location.href,title:document.title,entries:entries,headings:h,text:body}};
}})()"#
    )
}

/// One resolved element: what a ref points at, plus where it currently is.
#[derive(Clone, Debug)]
struct SnapEntry {
    role: String,
    name: String,
    /// Which occurrence of `(role, name)` this is (0-based).
    nth: usize,
}

/// The refs one snapshot handed out. Kept per chat by version so a ref printed
/// three turns ago still resolves as long as the element is still on the page.
struct Snapshot {
    text: String,
    entries: Vec<SnapEntry>,
    /// Ref number of `entries[0]`. Refs are MONOTONIC across snapshots and are
    /// never reset, so a printed ref is NOT an index into `entries`: the offset
    /// has to be subtracted before looking up (see `entry_for`).
    base_ref: usize,
    /// Signature of the page when this snapshot was taken (cheap "unchanged").
    sig: u64,
}

// ---------------------------------------------------------------------------
// CDP connection: one WebSocket, a writer task and a reader loop
// ---------------------------------------------------------------------------

type Pending = Arc<Mutex<HashMap<u64, Waiter<Result<Value, String>>>>>;

/// A live CDP session bound to ONE tab.
struct CdpConn {
    /// Outgoing frames, consumed by the writer task on the runtime thread.
    tx: mpsc::UnboundedSender<String>,
    /// Commands waiting for their reply, keyed by request id.
    pending: Pending,
    /// `Target.attachToTarget` session, sent with every page command.
    session: String,
    /// `Page.loadEventFired` counter — the navigation-settled signal.
    load_count: Arc<AtomicU64>,
    /// Console/exception log captured by the reader loop.
    logs: Arc<Mutex<Vec<Value>>>,
    /// Network request log captured by the reader loop.
    net: Arc<Mutex<Vec<Value>>>,
    /// What to do with the NEXT `javascriptDialogOpening` (accept, prompt text).
    dialog: Arc<Mutex<(bool, String)>>,
}

impl CdpConn {
    /// Open the browser-level WebSocket, attach to `target`, and hand back a
    /// connection whose reader loop is already running.
    fn start(ws_url: String, target: String) -> Result<Self, String> {
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let load_count = Arc::new(AtomicU64::new(0));
        let logs: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let net: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let dialog: Arc<Mutex<(bool, String)>> = Arc::new(Mutex::new((false, String::new())));

        // Readiness handshake: the caller must learn WHY a connect failed, but
        // nothing may outlive the handshake or a failed connect would block the
        // caller for the full timeout.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<String, String>>();
        let err_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let p = pending.clone();
        let lc = load_count.clone();
        let lg = logs.clone();
        let nt = net.clone();
        let dl = dialog.clone();
        let errs = err_slot.clone();
        let tx_events = tx.clone();

        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("browser runtime: {e}")));
                    return;
                }
            };
            let outcome: Result<(), String> = rt.block_on(async move {
                let ws = tokio_tungstenite::connect_async(&ws_url)
                    .await
                    .map_err(|e| format!("cdp connect failed: {e}"))?
                    .0;
                let (mut sink, mut stream) = ws.split();
                let attach = json!({
                    "id": 1u64,
                    "method": "Target.attachToTarget",
                    "params": {"targetId": target, "flatten": true},
                });
                sink.send(Message::Text(attach.to_string().into()))
                    .await
                    .map_err(|e| format!("cdp attach send: {e}"))?;
                let deadline = Instant::now() + CDP_CALL_TIMEOUT;
                let mut session: Option<String> = None;
                while session.is_none() {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err("timed out attaching to the tab".to_string());
                    }
                    let next = match tokio::time::timeout(left, stream.next()).await {
                        Ok(Some(Ok(msg))) => msg,
                        Ok(Some(Err(e))) => return Err(format!("cdp attach: {e}")),
                        _ => return Err("cdp closed while attaching".to_string()),
                    };
                    let Message::Text(txt) = next else { continue };
                    let Ok(v) = serde_json::from_str::<Value>(&txt) else {
                        continue;
                    };
                    if v.get("id").and_then(Value::as_u64) != Some(1) {
                        continue;
                    }
                    if let Some(err) = v.get("error") {
                        return Err(format!("attach failed: {err}"));
                    }
                    session = v["result"]["sessionId"].as_str().map(str::to_string);
                }
                let session = session.expect("session checked above");
                let session_for_events = session.clone();
                let _ = ready_tx.send(Ok(session));

                let mut rx = rx;
                let writer = async move {
                    while let Some(txt) = rx.recv().await {
                        if sink.send(Message::Text(txt.into())).await.is_err() {
                            break;
                        }
                    }
                };
                let reader = async move {
                    let mut open: HashMap<String, usize> = HashMap::new();
                    while let Some(Ok(msg)) = stream.next().await {
                        let Message::Text(txt) = msg else { continue };
                        let Ok(v) = serde_json::from_str::<Value>(&txt) else {
                            continue;
                        };
                        if let Some(id) = v.get("id").and_then(Value::as_u64) {
                            if id == NO_REPLY_ID {
                                continue;
                            }
                            let waiter = p.lock().ok().and_then(|mut m| m.remove(&id));
                            if let Some(w) = waiter {
                                let _ = match v.get("error") {
                                    Some(err) => w.send(Err(format!("cdp error: {err}"))),
                                    None => w.send(Ok(v
                                        .get("result")
                                        .cloned()
                                        .unwrap_or(Value::Null))),
                                };
                            }
                            continue;
                        }
                        let method = v.get("method").and_then(Value::as_str).unwrap_or_default();
                        let params = v.get("params").cloned().unwrap_or(Value::Null);
                        match method {
                            "Page.loadEventFired" => {
                                // The only event whose counter the driver reads
                                // back: `wait_load` blocks on it.
                                lc.fetch_add(1, Ordering::Relaxed);
                            }
                            "Runtime.consoleAPICalled" => push_capped(
                                &lg,
                                json!({
                                    "kind": "console",
                                    "level": params["type"].as_str().unwrap_or("log"),
                                    "time": params["timestamp"].as_f64().unwrap_or_default(),
                                    "text": console_text(&params["args"]),
                                }),
                                LOG_CAP,
                            ),
                            "Runtime.exceptionThrown" => push_capped(
                                &lg,
                                json!({
                                    "kind": "exception",
                                    "level": "error",
                                    "time": params["timestamp"].as_f64().unwrap_or_default(),
                                    "text": params["exceptionDetails"]["exception"]["description"]
                                        .as_str()
                                        .or_else(|| params["exceptionDetails"]["text"].as_str())
                                        .unwrap_or("uncaught exception"),
                                }),
                                LOG_CAP,
                            ),
                            "Log.entryAdded" => {
                                let e = &params["entry"];
                                push_capped(
                                    &lg,
                                    json!({
                                        "kind": "log",
                                        "level": e["level"].as_str().unwrap_or("info"),
                                        "time": e["timestamp"].as_f64().unwrap_or_default(),
                                        "text": e["text"].as_str().unwrap_or_default(),
                                    }),
                                    LOG_CAP,
                                );
                            }
                            "Network.requestWillBeSent" => {
                                let id = params["requestId"].as_str().unwrap_or_default().to_string();
                                let mut buf = match nt.lock() {
                                    Ok(b) => b,
                                    Err(_) => continue,
                                };
                                if buf.len() >= NET_CAP {
                                    buf.remove(0);
                                    open.clear();
                                }
                                open.insert(id.clone(), buf.len());
                                buf.push(json!({
                                    "id": id,
                                    "method": params["request"]["method"].as_str().unwrap_or_default(),
                                    "url": params["request"]["url"].as_str().unwrap_or_default(),
                                    "type": params["type"].as_str().unwrap_or_default(),
                                    "status": null,
                                }));
                            }
                            "Network.responseReceived" => {
                                let id = params["requestId"].as_str().unwrap_or_default();
                                if let (Ok(mut buf), Some(&idx)) = (nt.lock(), open.get(id)) {
                                    if let Some(row) = buf.get_mut(idx) {
                                        row["status"] = params["response"]["status"].clone();
                                    }
                                }
                            }
                            "Page.javascriptDialogOpening" => {
                                let accept = dl.lock().map(|d| d.0).unwrap_or(false);
                                let prompt = dl
                                    .lock()
                                    .map(|d| d.1.clone())
                                    .unwrap_or_default();
                                push_capped(
                                    &lg,
                                    json!({
                                        "kind": "dialog",
                                        "level": "warn",
                                        "time": 0,
                                        "text": format!(
                                            "{} ({}): {}",
                                            params["type"].as_str().unwrap_or("dialog"),
                                            if accept { "accepted" } else { "dismissed" },
                                            params["message"].as_str().unwrap_or_default()
                                        ),
                                    }),
                                    LOG_CAP,
                                );
                                // A dialog blocks every later command, so it is
                                // always answered; the policy only decides HOW.
                                let reply = json!({
                                    "id": NO_REPLY_ID,
                                    "method": "Page.handleJavaScriptDialog",
                                    "sessionId": session_for_events,
                                    "params": {"accept": accept, "promptText": prompt},
                                });
                                let _ = tx_events.send(reply.to_string());
                            }
                            _ => {}
                        }
                    }
                };
                tokio::join!(writer, reader);
                Ok(())
            });
            if let Err(e) = outcome {
                if let Ok(mut slot) = errs.lock() {
                    *slot = Some(e);
                }
            }
        });

        match ready_rx.recv_timeout(CDP_CALL_TIMEOUT + Duration::from_secs(5)) {
            Ok(Ok(session)) => Ok(Self {
                tx,
                pending,
                session,
                load_count,
                logs,
                net,
                dialog,
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                let reason = err_slot
                    .lock()
                    .ok()
                    .and_then(|s| s.clone())
                    .unwrap_or_else(|| "the browser connection closed".to_string());
                Err(reason)
            }
        }
    }

    /// Attach this connection to another tab of the same browser.
    fn attach(&mut self, target: &str) -> Result<(), String> {
        let res = self.call(
            "Target.attachToTarget",
            json!({"targetId": target, "flatten": true}),
        )?;
        let session = res["sessionId"]
            .as_str()
            .ok_or_else(|| "attachToTarget returned no sessionId".to_string())?;
        self.session = session.to_string();
        Ok(())
    }

    fn enable_domains(&mut self) {
        // Failures are non-fatal: an old Chromium may not support a domain, and
        // the op that actually needs it will report the real error.
        for method in [
            "Page.enable",
            "Runtime.enable",
            "Log.enable",
            "Network.enable",
            "DOM.enable",
        ] {
            let _ = self.call(method, json!({}));
        }
    }
}

/// Render `Runtime.consoleAPICalled` args into one line.
fn console_text(args: &Value) -> String {
    let Some(list) = args.as_array() else {
        return String::new();
    };
    let mut parts = Vec::new();
    for a in list {
        if let Some(s) = a["value"].as_str() {
            parts.push(s.to_string());
        } else if let Some(s) = a["description"].as_str() {
            parts.push(s.to_string());
        } else if let Some(v) = a["value"].as_f64() {
            parts.push(v.to_string());
        } else if let Some(v) = a["value"].as_bool() {
            parts.push(v.to_string());
        } else {
            parts.push(a["type"].as_str().unwrap_or("object").to_string());
        }
    }
    parts.join(" ")
}

fn push_capped(buf: &Arc<Mutex<Vec<Value>>>, item: Value, cap: usize) {
    if let Ok(mut b) = buf.lock() {
        if b.len() >= cap {
            b.remove(0);
        }
        b.push(item);
    }
}

// ---------------------------------------------------------------------------
// Driver: one per chat, holding the ref table
// ---------------------------------------------------------------------------

struct Driver {
    chat: String,
    /// Target id of the tab this driver is attached to (the `tabs` op switches
    /// it; `hooks::set_target` keeps the panel's registry in step).
    target: String,
    conn: CdpConn,
    /// Monotonic ref counter: a ref is never reused, so an old one either
    /// resolves to its element or reports "gone".
    next_ref: usize,
    /// Snapshots whose refs are still resolvable, newest last.
    snapshots: Vec<(usize, Snapshot)>,
    /// Version of the newest snapshot.
    current: Option<usize>,
    seq: usize,
}

/// Per-chat drivers. A plain `Mutex<Vec<..>>` so the static stays
/// `const`-constructible, matching the registry style in `browser.rs`.
static DRIVERS: Mutex<Vec<(String, Arc<Mutex<Driver>>)>> = Mutex::new(Vec::new());

impl Driver {
    fn connect(chat: &str) -> Result<Self, String> {
        // `ensure_target` starts the whole browser when the chat has no tab yet,
        // so the agent's first browser call works without the panel being open.
        let target = hooks::ensure_target(chat)?;
        let port = hooks::port().ok_or_else(|| "browser is not running".to_string())?;
        let ws_url = hooks::ws_url(port)?;
        let mut conn = CdpConn::start(ws_url, target.clone())?;
        conn.enable_domains();
        Ok(Self {
            chat: chat.to_string(),
            target,
            conn,
            next_ref: 1,
            snapshots: Vec::new(),
            current: None,
            seq: 0,
        })
    }

    fn url(&self) -> String {
        self.eval("location.href", false)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default()
    }

    fn title(&self) -> String {
        self.eval("document.title", false)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default()
    }

    /// `Runtime.evaluate`, returning the value (not the node).
    fn eval(&self, expr: &str, await_promise: bool) -> Result<Value, String> {
        eval_on(&self.conn, expr, await_promise)
    }
}

fn eval_on(conn: &CdpConn, expr: &str, await_promise: bool) -> Result<Value, String> {
    let res = conn.call(
        "Runtime.evaluate",
        json!({
            "expression": expr,
            "returnByValue": true,
            "awaitPromise": await_promise,
            "userGesture": true,
        }),
    )?;
    if res["exceptionDetails"].is_object() {
        return Err(format!(
            "page error: {}",
            res["exceptionDetails"]["exception"]["description"]
                .as_str()
                .or_else(|| res["exceptionDetails"]["text"].as_str())
                .unwrap_or("evaluation failed")
        ));
    }
    Ok(res["result"]["value"].clone())
}

fn node_on(conn: &CdpConn, expr: &str) -> Result<String, String> {
    let res = conn.call(
        "Runtime.evaluate",
        json!({
            "expression": expr,
            "returnByValue": false,
            "awaitPromise": false,
            "userGesture": true,
        }),
    )?;
    res["result"]["objectId"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| {
            let detail = res["result"]["description"]
                .as_str()
                .unwrap_or("no element matched");
            format!("element not found ({detail})")
        })
}

impl CdpConn {
    /// Send one command and wait for its reply.
    ///
    /// Takes `&self`: a driver op holds the driver lock for its whole duration,
    /// so the reader loop (which owns the other half) must never need it. The
    /// request id comes from a global atomic so two connections can never mint
    /// the same id.
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call_timeout(method, params, CDP_CALL_TIMEOUT)
    }

    fn call_timeout(&self, method: &str, params: Value, ttl: Duration) -> Result<Value, String> {
        let id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let mut p = self.pending.lock().map_err(|_| "cdp pending lock poisoned")?;
            p.insert(id, tx);
        }
        let browser_level = method.starts_with("Target.") || method.starts_with("Browser.");
        let mut msg = json!({"id": id, "method": method, "params": params});
        if !browser_level {
            msg["sessionId"] = json!(self.session);
        }
        if self.tx.send(msg.to_string()).is_err() {
            if let Ok(mut p) = self.pending.lock() {
                p.remove(&id);
            }
            return Err("the browser connection is closed".to_string());
        }
        match rx.recv_timeout(ttl) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                Err(format!("cdp {method} timed out"))
            }
        }
    }
}

/// Global request counter: two connections in the same process must never mint
/// the same id, because the reader loop routes replies by id alone. Starts well
/// above the ids the attach handshake uses so the two shapes never collide.
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1_000_000);

// ---------------------------------------------------------------------------
// Driver registry
// ---------------------------------------------------------------------------

/// True when an error means the connection (not the command) is gone, so the
/// caller should reconnect once and retry.
fn is_stale(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("connection is closed")
        || e.contains("no target")
        || e.contains("session with given id not found")
        || e.contains("target closed")
        || e.contains("inspected target navigated or closed")
        || e.contains("cdp attach")
        || e.contains("cdp connect failed")
}

fn chat_key(chat: &str) -> String {
    hooks::chat_key(chat)
}

fn cached_driver(chat: &str) -> Option<Arc<Mutex<Driver>>> {
    let list = DRIVERS.lock().ok()?;
    list.iter()
        .find(|(k, _)| k == chat)
        .map(|(_, d)| d.clone())
}

fn store_driver(chat: &str, driver: Arc<Mutex<Driver>>) -> Arc<Mutex<Driver>> {
    let Ok(mut list) = DRIVERS.lock() else {
        return driver;
    };
    if let Some((_, existing)) = list.iter().find(|(k, _)| k == chat) {
        // Another thread won the race: keep its connection, drop ours.
        return existing.clone();
    }
    list.push((chat.to_string(), driver.clone()));
    driver
}

fn driver_for(chat: &str) -> Result<Arc<Mutex<Driver>>, String> {
    if let Some(d) = cached_driver(chat) {
        return Ok(d);
    }
    let fresh = Arc::new(Mutex::new(Driver::connect(chat)?));
    Ok(store_driver(chat, fresh))
}

/// Drop the cached driver for a chat (used when the connection died).
fn drop_driver(chat: &str) {
    if let Ok(mut list) = DRIVERS.lock() {
        list.retain(|(k, _)| k != chat);
    }
}

/// Forget a chat's driver from outside this module (called when the browser
/// reaps that chat's tab).
///
/// The cached driver holds a CDP WebSocket and the page snapshots it collected;
/// once its target is closed it can never answer again, so keeping it is a
/// retained allocation plus a ref table that will never resolve. Only the
/// module's own `drop_driver` knew how to release it.
pub(crate) fn forget(chat: &str) {
    drop_driver(&chat_key(chat));
}

/// Run `f` with the chat's driver, reconnecting ONCE when the connection turns
/// out to be dead (the browser was reaped, the tab was closed, the renderer
/// swapped processes on a cross-site navigation).
fn with_driver<F, T>(chat: &str, mut f: F) -> Result<T, String>
where
    F: FnMut(&mut Driver) -> Result<T, String>,
{
    let key = chat_key(chat);
    let handle = driver_for(&key)?;
    let mut guard = handle
        .lock()
        .map_err(|_| "browser driver lock poisoned".to_string())?;
    match f(&mut guard) {
        Ok(v) => Ok(v),
        Err(e) if is_stale(&e) => {
            drop(guard);
            drop_driver(&key);
            let fresh = driver_for(&key)?;
            let mut guard = fresh
                .lock()
                .map_err(|_| "browser driver lock poisoned".to_string())?;
            f(&mut guard)
        }
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Refs, elements and coordinates
// ---------------------------------------------------------------------------

fn ref_of(args: &Value) -> Option<usize> {
    if let Some(n) = args["ref"].as_u64() {
        return Some(n as usize);
    }
    let raw = args["ref"].as_str()?.trim();
    let digits = raw
        .trim_start_matches("@")
        .trim_start_matches("e")
        .trim_start_matches('-');
    digits.parse::<usize>().ok()
}

/// Map a printed ref to its index inside the snapshot that handed it out.
///
/// Refs are monotonic across snapshots (`next_ref` is never reset), so a ref is
/// NOT an array index — the snapshot's `base_ref` must be subtracted. Returns
/// `None` when `wanted` was handed out by a different snapshot (older or newer).
fn ref_index(base_ref: usize, len: usize, wanted: usize) -> Option<usize> {
    if wanted < base_ref {
        return None; // handed out by an OLDER snapshot
    }
    let index = wanted - base_ref;
    if index >= len {
        return None; // handed out by a NEWER snapshot
    }
    Some(index)
}

/// Resolve a ref against the newest snapshot that contains it.
///
/// Treating the ref as a direct index made every ref resolve to the NEXT entry
/// (ref [1] — the button — hit entries[1], the input), so clicks landed on the
/// wrong element.
fn entry_for(d: &Driver, wanted: usize) -> Option<SnapEntry> {
    for (_version, snap) in d.snapshots.iter().rev() {
        if let Some(index) = ref_index(snap.base_ref, snap.entries.len(), wanted) {
            return snap.entries.get(index).cloned();
        }
    }
    None
}

/// The CSS/text selector path, for callers that have no ref.
fn selector_expr(args: &Value) -> Option<String> {
    let sel = args["selector"].as_str().map(str::trim).filter(|s| !s.is_empty());
    if let Some(sel) = sel {
        return Some(format!(
            "document.querySelector({})",
            serde_json::to_string(sel).unwrap_or_else(|_| "\"\"".into())
        ));
    }
    let text = args["text"].as_str().map(str::trim).filter(|s| !s.is_empty())?;
    // Text without a ref: ask the injected matcher, which knows the same
    // role/name rules the snapshot used.
    let literal = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    Some(format!(
        "(function(){{var m=__cfMatch('',{0},0);if(m) return m;var c=__cfCandidates();\
         for(var i=0;i<c.length;i++){{if(c[i].name.indexOf({0})>=0) return c[i].el;}}return null;}})()",
        literal
    ))
}

/// Resolve whatever the call used (ref / selector / text) into an objectId.
fn resolve_node(d: &mut Driver, args: &Value) -> Result<String, String> {
    if let Some(wanted) = ref_of(args) {
        let entry = entry_for(d, wanted).ok_or_else(|| {
            format!("ref [{wanted}] is unknown — run browser_snapshot again to get fresh refs")
        })?;
        let expr = format!(
            "__cfMatch({}, {}, {})",
            serde_json::to_string(&entry.role).unwrap_or_else(|_| "\"\"".into()),
            serde_json::to_string(&entry.name).unwrap_or_else(|_| "\"\"".into()),
            entry.nth
        );
        return node_on(&mut &d.conn, &js(&expr));
    }
    let expr = selector_expr(args).ok_or_else(|| {
        "pass `ref` (from browser_snapshot), or `selector`, or `text`".to_string()
    })?;
    node_on(&mut &d.conn, &js(&expr))
}

/// Scroll an element into view and return its centre point.
fn element_point(d: &mut Driver, object_id: &str) -> Result<(i64, i64), String> {
    let conn = &d.conn;
    let _ = conn.call(
        "DOM.scrollIntoViewIfNeeded",
        json!({"objectId": object_id}),
    );
    let res = conn.call(
        "Runtime.callFunctionOn",
        json!({
            "objectId": object_id,
            "functionDeclaration": "function(){var r=this.getBoundingClientRect();\
                return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)});}",
            "returnByValue": true,
        }),
    )?;
    let raw = res["result"]["value"].as_str().unwrap_or("{}");
    let parsed: Value = serde_json::from_str(raw).unwrap_or_else(|_| json!({}));
    let x = parsed["x"].as_i64().unwrap_or(-1);
    let y = parsed["y"].as_i64().unwrap_or(-1);
    if x < 0 || y < 0 {
        return Err("the element has no clickable box (it may be hidden)".to_string());
    }
    Ok((x, y))
}

fn modifier_bits(args: &Value) -> i64 {
    let mut bits = 0;
    if let Some(list) = args["modifiers"].as_array() {
        for m in list {
            match m.as_str().unwrap_or_default().to_ascii_lowercase().as_str() {
                "alt" | "option" => bits |= 1,
                "ctrl" | "control" => bits |= 2,
                "meta" | "cmd" | "command" | "super" => bits |= 4,
                "shift" => bits |= 8,
                _ => {}
            }
        }
    }
    bits
}

fn mouse(d: &mut Driver, kind: &str, x: i64, y: i64, extra: Value) -> Result<(), String> {
    let mut params = json!({"type": kind, "x": x, "y": y});
    if let (Some(dst), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            dst.insert(k.clone(), v.clone());
        }
    }
    let conn = &d.conn;
    conn.call("Input.dispatchMouseEvent", params)?;
    Ok(())
}

/// Wait until the page's load event fires after `before`, or until it reports
/// `complete` twice in a row (a same-document navigation never fires `load`).
fn wait_load(d: &mut Driver, before: u64, ttl: Duration) -> Result<(), String> {
    let deadline = Instant::now() + ttl;
    // Give the navigation a beat to start before trusting `readyState`, which
    // still describes the page being left.
    std::thread::sleep(Duration::from_millis(120));
    let mut complete = 0;
    loop {
        if d.conn.load_count.load(Ordering::Relaxed) > before {
            return Ok(());
        }
        if let Ok(v) = d.eval("document.readyState", false) {
            if v.as_str() == Some("complete") {
                complete += 1;
                if complete >= 2 {
                    return Ok(());
                }
            } else {
                complete = 0;
            }
        }
        if Instant::now() >= deadline {
            // A slow page is not a failed navigation: report the URL we got to.
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// fnv-ish signature of a snapshot payload, for the "unchanged" shortcut.
fn signature(v: &Value) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    v["url"].as_str().unwrap_or_default().hash(&mut h);
    v["title"].as_str().unwrap_or_default().hash(&mut h);
    if let Some(list) = v["entries"].as_array() {
        for e in list {
            e["role"].as_str().unwrap_or_default().hash(&mut h);
            e["name"].as_str().unwrap_or_default().hash(&mut h);
            e["x"].as_i64().unwrap_or_default().hash(&mut h);
            e["y"].as_i64().unwrap_or_default().hash(&mut h);
        }
    }
    let text = v["text"].as_str().unwrap_or_default();
    text.len().hash(&mut h);
    h.finish()
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

fn op_snapshot(d: &mut Driver) -> Result<Value, String> {
    let raw = {
        let conn = &d.conn;
        let res = conn.call(
            "Runtime.evaluate",
            json!({
                "expression": js_snapshot(),
                "returnByValue": true,
                "awaitPromise": false,
                "userGesture": true,
            }),
        )?;
        if res["exceptionDetails"].is_object() {
            return Err(format!(
                "snapshot failed: {}",
                res["exceptionDetails"]["text"]
                    .as_str()
                    .unwrap_or("page error")
            ));
        }
        res["result"]["value"].clone()
    };
    if !raw.is_object() {
        return Err("snapshot returned no data (the page may be loading)".to_string());
    }
    let sig = signature(&raw);
    if let Some(version) = d.current {
        if let Some((_, snap)) = d.snapshots.iter().find(|(v, _)| *v == version) {
            if snap.sig == sig {
                return Ok(json!({
                    "text": format!(
                        "[unchanged since refs v{version} — the refs below are still valid]\n{}",
                        snap.text
                    ),
                    "version": version,
                    "unchanged": true,
                }));
            }
        }
    }

    let url = raw["url"].as_str().unwrap_or_default().to_string();
    let title = raw["title"].as_str().unwrap_or_default().to_string();

    let mut entries: Vec<SnapEntry> = Vec::new();
    let mut seen: HashMap<(String, String), usize> = HashMap::new();
    let mut body = String::new();
    // The ref printed for `entries[0]`: refs are monotonic across snapshots, so
    // the offset between the printed number and the array index has to be kept.
    let base_ref = d.next_ref;
    for e in raw["entries"].as_array().cloned().unwrap_or_default() {
        let role = e["role"].as_str().unwrap_or("element").to_string();
        let name = e["name"].as_str().unwrap_or_default().to_string();
        let nth = {
            let slot = seen.entry((role.clone(), name.clone())).or_insert(0);
            let n = *slot;
            *slot += 1;
            n
        };
        entries.push(SnapEntry {
            role: role.clone(),
            name: name.clone(),
            nth,
        });
        let label = if name.is_empty() {
            role.clone()
        } else {
            format!("{role} \"{name}\"")
        };
        body.push_str(&format!("- [{}] {label}\n", d.next_ref));
        d.next_ref += 1;
    }

    let mut text = format!("Page: {title}\nURL: {url}\n");
    if entries.is_empty() {
        text.push_str("\n(no interactive elements found)\n");
    } else {
        text.push_str(&format!("\nInteractive ({}):\n{body}", entries.len()));
    }
    let headings = raw["headings"].as_array().cloned().unwrap_or_default();
    if !headings.is_empty() {
        text.push_str("\nHeadings:\n");
        for h in headings {
            text.push_str(&format!(
                "- {} \"{}\"\n",
                h["role"].as_str().unwrap_or("h"),
                h["name"].as_str().unwrap_or_default()
            ));
        }
    }
    let page_text = raw["text"].as_str().unwrap_or_default();
    if !page_text.is_empty() {
        text.push_str("\nPage text:\n");
        text.push_str(page_text);
    }
    if text.chars().count() > SNAPSHOT_MAX_CHARS {
        let kept: String = text.chars().take(SNAPSHOT_MAX_CHARS).collect();
        text = format!(
            "{kept}\n…[snapshot truncated at {SNAPSHOT_MAX_CHARS} chars — \
             use browser_find or browser_evaluate for the rest]"
        );
    }

    d.seq += 1;
    let version = d.seq;
    let snap = Snapshot {
        text: text.clone(),
        entries,
        base_ref,
        sig,
    };
    d.snapshots.push((version, snap));
    if d.snapshots.len() > MAX_SNAPSHOTS {
        d.snapshots.remove(0);
    }
    d.current = Some(version);

    Ok(json!({
        "text": format!("refs v{version}\n\n{text}"),
        "version": version,
        "unchanged": false,
    }))
}

fn op_navigate(d: &mut Driver, url: &str) -> Result<Value, String> {
    let target = url.trim();
    if target.is_empty() {
        return Err("navigate needs a url".to_string());
    }
    let before = d.conn.load_count.load(Ordering::Relaxed);
    let res = {
        let conn = &d.conn;
        conn.call("Page.navigate", json!({"url": target}))?
    };
    if let Some(err) = res["errorText"].as_str() {
        if !err.is_empty() && err != "net::ERR_ABORTED" {
            return Err(format!("navigation failed: {err}"));
        }
    }
    wait_load(d, before, NAV_TIMEOUT)?;
    Ok(json!({
        "text": format!(
            "Navigated to {}\nTitle: {}\nNext: browser_snapshot to see the page.",
            d.url(), d.title()
        ),
        "url": d.url(),
        "title": d.title(),
    }))
}

fn op_navigate_back(d: &mut Driver) -> Result<Value, String> {
    let before = d.conn.load_count.load(Ordering::Relaxed);
    {
        let conn = &d.conn;
        conn.call(
            "Runtime.evaluate",
            json!({"expression": "history.back()", "returnByValue": true}),
        )?;
    }
    wait_load(d, before, Duration::from_secs(15))?;
    Ok(json!({
        "text": format!("Went back to {}\nTitle: {}", d.url(), d.title()),
        "url": d.url(),
    }))
}

fn op_click(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let node = resolve_node(d, args)?;
    let (x, y) = element_point(d, &node)?;
    let modifiers = modifier_bits(args);
    let button = args["button"].as_str().unwrap_or("left");
    let clicks = args["click_count"].as_i64().unwrap_or(1).clamp(1, 3);
    let before = d.conn.load_count.load(Ordering::Relaxed);
    // Make the tab the ACTIVE one before pressing. A background target does not
    // receive input events: the dispatch is answered ("ok") but the renderer
    // never sees a click, so a handler never fires. The panel's Chromium is
    // shared, so "the tab the agent is driving" is not necessarily the front
    // one.
    {
        let conn = &d.conn;
        let _ = conn.call("Page.bringToFront", json!({}));
    }
    mouse(
        d,
        "mouseMoved",
        x,
        y,
        json!({"button": "none", "buttons": 0, "modifiers": modifiers}),
    )?;
    mouse(
        d,
        "mousePressed",
        x,
        y,
        json!({"button": button, "clickCount": clicks, "buttons": 1, "modifiers": modifiers}),
    )?;
    mouse(
        d,
        "mouseReleased",
        x,
        y,
        json!({"button": button, "clickCount": clicks, "buttons": 0, "modifiers": modifiers}),
    )?;
    // A click may start a navigation: give it a short chance to settle so the
    // next command sees the new document.
    wait_load(d, before, Duration::from_secs(5))?;
    Ok(json!({
        "text": format!("Clicked at ({x}, {y}) — now on {}", d.url()),
        "url": d.url(),
    }))
}

fn op_hover(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let node = resolve_node(d, args)?;
    let (x, y) = element_point(d, &node)?;
    mouse(
        d,
        "mouseMoved",
        x,
        y,
        json!({"button": "none", "buttons": 0}),
    )?;
    Ok(json!({"text": format!("Hovering at ({x}, {y})")}))
}

/// Focus a node so typing lands in it.
fn focus_node(d: &mut Driver, object_id: &str) -> Result<(), String> {
    let conn = &d.conn;
    if conn
        .call("DOM.focus", json!({"objectId": object_id}))
        .is_ok()
    {
        return Ok(());
    }
    // Not focusable through DOM.focus (a div with a click handler, say):
    // click it instead, which is what a person would do.
    let (x, y) = element_point(d, object_id)?;
    mouse(
        d,
        "mousePressed",
        x,
        y,
        json!({"button": "left", "clickCount": 1, "buttons": 1}),
    )?;
    mouse(
        d,
        "mouseReleased",
        x,
        y,
        json!({"button": "left", "clickCount": 1, "buttons": 0}),
    )
}

/// Replace the focused element's content and type `text` into it.
fn type_into(d: &mut Driver, node: Option<&str>, text: &str, clear: bool) -> Result<(), String> {
    if let Some(node) = node {
        focus_node(d, node)?;
    }
    if clear {
        // Select the field's current content so `insertText` replaces it — the
        // React-friendly equivalent of Cmd+A, Backspace.
        let conn = &d.conn;
        let _ = conn.call(
            "Runtime.evaluate",
            json!({
                "expression": "(function(){var el=document.activeElement;\
                    if(el&&el.select){el.select();}\
                    else if(el&&el.setSelectionRange){el.setSelectionRange(0,(el.value||'').length);}\
                    return true;})()",
                "returnByValue": true,
            }),
        );
    }
    let conn = &d.conn;
    conn.call("Input.insertText", json!({"text": text}))?;
    Ok(())
}

fn op_type(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let text = args["text"].as_str().unwrap_or_default();
    if text.is_empty() {
        return Err("type needs `text`".to_string());
    }
    let node = if ref_of(args).is_some() || args["selector"].as_str().is_some() {
        Some(resolve_node(d, args)?)
    } else {
        None
    };
    let clear = args["clear"].as_bool().unwrap_or(false);
    type_into(d, node.as_deref(), text, clear)?;
    if args["submit"].as_bool().unwrap_or(false) {
        press_key(d, "Enter", 0)?;
    }
    Ok(json!({
        "text": format!(
            "Typed {} character(s){}",
            text.chars().count(),
            if args["submit"].as_bool().unwrap_or(false) { " and pressed Enter" } else { "" }
        )
    }))
}

fn op_fill_form(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let fields = args["fields"]
        .as_array()
        .cloned()
        .ok_or_else(|| "fill_form needs `fields` (an array)".to_string())?;
    if fields.is_empty() {
        return Err("fill_form needs at least one field".to_string());
    }
    let mut done = Vec::new();
    for field in fields {
        let value = field["value"]
            .as_str()
            .or_else(|| field["text"].as_str())
            .unwrap_or_default()
            .to_string();
        let node = resolve_node(d, &field)?;
        type_into(d, Some(&node), &value, true)?;
        done.push(
            field["ref"]
                .as_u64()
                .map(|r| format!("[{r}]"))
                .unwrap_or_else(|| field["selector"].as_str().unwrap_or("field").to_string()),
        );
    }
    Ok(json!({
        "text": format!("Filled {} field(s): {}", done.len(), done.join(", "))
    }))
}

fn op_select_option(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let value = args["value"].as_str().unwrap_or_default().to_string();
    if value.is_empty() {
        return Err("select_option needs `value`".to_string());
    }
    let node = resolve_node(d, args)?;
    let conn = &d.conn;
    let res = conn.call(
        "Runtime.callFunctionOn",
        json!({
            "objectId": node,
            "functionDeclaration": "function(want){\
                this.value=want;\
                this.dispatchEvent(new Event('input',{bubbles:true}));\
                this.dispatchEvent(new Event('change',{bubbles:true}));\
                return this.value;}",
            "arguments": [{"value": value}],
            "returnByValue": true,
        }),
    )?;
    Ok(json!({
        "text": format!(
            "Selected \"{}\" (the field now reads \"{}\")",
            value,
            res["result"]["value"].as_str().unwrap_or_default()
        )
    }))
}

/// (virtual key code, key, code) for a named key or a single character.
fn key_triple(spec: &str) -> Option<(i64, String, String)> {
    let named = match spec.to_ascii_lowercase().as_str() {
        "enter" | "return" => Some((13, "Enter", "Enter")),
        "tab" => Some((9, "Tab", "Tab")),
        "escape" | "esc" => Some((27, "Escape", "Escape")),
        "backspace" => Some((8, "Backspace", "Backspace")),
        "delete" | "del" => Some((46, "Delete", "Delete")),
        "arrowup" | "up" => Some((38, "ArrowUp", "ArrowUp")),
        "arrowdown" | "down" => Some((40, "ArrowDown", "ArrowDown")),
        "arrowleft" | "left" => Some((37, "ArrowLeft", "ArrowLeft")),
        "arrowright" | "right" => Some((39, "ArrowRight", "ArrowRight")),
        "home" => Some((36, "Home", "Home")),
        "end" => Some((35, "End", "End")),
        "pageup" => Some((33, "PageUp", "PageUp")),
        "pagedown" => Some((34, "PageDown", "PageDown")),
        "space" => Some((32, " ", "Space")),
        _ => None,
    };
    if let Some((code, key, dom)) = named {
        return Some((code, key.to_string(), dom.to_string()));
    }
    let mut chars = spec.chars();
    let ch = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    let code = match ch {
        'a'..='z' => ch as i64 - 32,
        'A'..='Z' => ch as i64,
        '0'..='9' => ch as i64,
        ' ' => 32,
        '-' => 189,
        '=' => 187,
        '[' => 219,
        ']' => 221,
        '\\' => 220,
        ';' => 186,
        '\'' => 222,
        ',' => 188,
        '.' => 190,
        '/' => 191,
        '`' => 192,
        _ => return None,
    };
    let dom = match ch {
        'a'..='z' | 'A'..='Z' => format!("Key{}", ch.to_ascii_uppercase()),
        '0'..='9' => format!("Digit{ch}"),
        _ => format!("{ch}"),
    };
    Some((code, ch.to_string(), dom))
}

fn press_key(d: &mut Driver, spec: &str, modifiers: i64) -> Result<(), String> {
    // Accept the `Meta+A` combo spelling in addition to a bare key plus
    // the `modifiers` array.
    let (spec, modifiers) = match spec.rsplit_once('+') {
        Some((prefix, rest)) if !rest.is_empty() => {
            let mut bits = modifiers;
            for part in prefix.split('+') {
                bits |= match part.trim().to_ascii_lowercase().as_str() {
                    "alt" | "option" => 1,
                    "ctrl" | "control" => 2,
                    "meta" | "cmd" | "command" | "super" => 4,
                    "shift" => 8,
                    _ => 0,
                };
            }
            (rest, bits)
        }
        _ => (spec, modifiers),
    };
    let (code, key, dom) =
        key_triple(spec).ok_or_else(|| format!("unknown key: {spec:?}"))?;
    if modifiers == 0 && key.chars().count() == 1 && key != " " {
        // A lone character is just text: inserting it fires the same `input`
        // events as a keypress and cannot be swallowed by a keymap.
        let conn = &d.conn;
        conn.call("Input.insertText", json!({"text": key}))?;
        return Ok(());
    }
    let base = json!({
        "windowsVirtualKeyCode": code,
        "nativeVirtualKeyCode": code,
        "key": key,
        "code": dom,
        "modifiers": modifiers,
    });
    let down_type = if modifiers != 0 { "rawKeyDown" } else { "keyDown" };
    let mut down = base.clone();
    down["type"] = json!(down_type);
    if modifiers == 0 {
        down["text"] = json!(key);
    }
    let mut up = base;
    up["type"] = json!("keyUp");
    let conn = &d.conn;
    conn.call("Input.dispatchKeyEvent", down)?;
    conn.call("Input.dispatchKeyEvent", up)?;
    Ok(())
}

fn op_press_key(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let spec = args["key"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "press_key needs `key` (e.g. \"Enter\", \"Meta+A\")".to_string())?;
    press_key(d, spec, modifier_bits(args))?;
    Ok(json!({"text": format!("Pressed {spec}")}))
}

fn op_evaluate(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let expr = args["expression"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "evaluate needs `expression`".to_string())?;
    let value = d.eval(expr, true)?;
    let rendered = match &value {
        Value::String(s) => s.clone(),
        Value::Null => "(null)".to_string(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    let rendered = if rendered.chars().count() > 8_000 {
        let head: String = rendered.chars().take(8_000).collect();
        format!("{head}\n…[truncated]")
    } else {
        rendered
    };
    Ok(json!({"text": rendered}))
}

fn op_wait_for(d: &mut Driver, args: &Value) -> Result<Value, String> {
    if let Some(secs) = args["time"].as_f64() {
        let clamped = secs.clamp(0.0, 30.0);
        std::thread::sleep(Duration::from_secs_f64(clamped));
        return Ok(json!({"text": format!("Waited {clamped}s")}));
    }
    let text = args["text"].as_str().map(str::to_string);
    let gone = args["text_gone"].as_str().map(str::to_string);
    if text.is_none() && gone.is_none() {
        return Err("wait_for needs `text`, `text_gone` or `time`".to_string());
    }
    let deadline = Instant::now() + Duration::from_secs(args["timeout"].as_u64().unwrap_or(10).min(60));
    loop {
        if let Some(needle) = &text {
            let expr = format!(
                "document.body?(document.body.innerText||'').indexOf({})>=0:false",
                serde_json::to_string(needle).unwrap_or_else(|_| "\"\"".into())
            );
            if let Ok(v) = d.eval(&expr, false) {
                if v.as_bool().unwrap_or(false) {
                    return Ok(json!({"text": format!("Text appeared: {needle}")}));
                }
            }
        }
        if let Some(needle) = &gone {
            let expr = format!(
                "document.body?(document.body.innerText||'').indexOf({})<0:true",
                serde_json::to_string(needle).unwrap_or_else(|_| "\"\"".into())
            );
            if let Ok(v) = d.eval(&expr, false) {
                if v.as_bool().unwrap_or(false) {
                    return Ok(json!({"text": format!("Text disappeared: {needle}")}));
                }
            }
        }
        if Instant::now() >= deadline {
            let what = text.or(gone).unwrap_or_default();
            return Err(format!("timed out waiting for {what:?}"));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn op_console_messages(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let wanted = args["level"]
        .as_str()
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "info".to_string());
    if args["clear"].as_bool().unwrap_or(false) {
        if let Ok(mut l) = d.conn.logs.lock() {
            l.clear();
        }
        return Ok(json!({"text": "Console log cleared."}));
    }
    let entries = d.conn.logs.lock().map(|l| l.clone()).unwrap_or_default();
    let rank = |level: &str| match level {
        "error" => 3,
        "warn" | "warning" => 2,
        _ => 1,
    };
    let floor = if wanted.starts_with("err") {
        3
    } else if wanted.starts_with("warn") {
        2
    } else {
        1
    };
    let mut lines = Vec::new();
    for e in entries {
        let level = e["level"].as_str().unwrap_or("log");
        if rank(level) < floor {
            continue;
        }
        let kind = e["kind"].as_str().unwrap_or("console");
        lines.push(format!(
            "[{level}] ({kind}) {}",
            e["text"].as_str().unwrap_or_default()
        ));
    }
    if lines.is_empty() {
        return Ok(json!({"text": format!("No console messages at level {wanted} or above.")}));
    }
    Ok(json!({"text": lines.join("\n")}))
}

fn op_network_requests(d: &mut Driver, args: &Value) -> Result<Value, String> {
    if args["clear"].as_bool().unwrap_or(false) {
        if let Ok(mut n) = d.conn.net.lock() {
            n.clear();
        }
        return Ok(json!({"text": "Network log cleared."}));
    }
    let filter = args["filter"].as_str().unwrap_or_default().to_string();
    let entries = d.conn.net.lock().map(|n| n.clone()).unwrap_or_default();
    if entries.is_empty() {
        return Ok(json!({"text": "No network requests captured yet."}));
    }
    let mut lines = Vec::new();
    for e in entries {
        let url = e["url"].as_str().unwrap_or_default();
        if !filter.is_empty() && !url.contains(&filter) {
            continue;
        }
        lines.push(format!(
            "{:>4} {:<6} {}",
            e["status"]
                .as_i64()
                .map(|s| s.to_string())
                .unwrap_or_else(|| "—".to_string()),
            e["method"].as_str().unwrap_or("GET"),
            url
        ));
    }
    if lines.is_empty() {
        return Ok(json!({"text": format!("No requests matching {filter:?}.")}));
    }
    let shown: Vec<String> = lines.iter().rev().take(120).rev().cloned().collect();
    Ok(json!({
        "text": format!("{} request(s):\n{}", lines.len(), shown.join("\n"))
    }))
}

fn op_find(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let needle = args["text"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "find needs `text`".to_string())?;
    let expr = format!(
        r#"(function(){{var n={};var t=document.body?(document.body.innerText||''):'';
        var low=t.toLowerCase(),needle=n.toLowerCase(),out=[],i=0,from=0;
        while(out.length<10){{i=low.indexOf(needle,from);if(i<0)break;from=i+needle.length;
        out.push(t.slice(Math.max(0,i-80),Math.min(t.length,i+needle.length+80)).replace(/\s+/g,' ').trim());}}
        return JSON.stringify({{count:out.length,hits:out}});}})()"#,
        serde_json::to_string(needle).unwrap_or_else(|_| "\"\"".into())
    );
    let raw = d.eval(&expr, false)?;
    let parsed: Value = serde_json::from_str(raw.as_str().unwrap_or("{}"))
        .unwrap_or_else(|_| json!({"count": 0, "hits": []}));
    if parsed["count"].as_i64().unwrap_or(0) == 0 {
        return Ok(json!({"text": format!("No match for {needle:?} on this page.")}));
    }
    let hits = parsed["hits"].as_array().cloned().unwrap_or_default();
    let mut text = format!("{} match(es) for {needle:?}:\n", hits.len());
    for h in hits {
        text.push_str(&format!("… {} …\n", h.as_str().unwrap_or_default()));
    }
    Ok(json!({"text": text}))
}

fn op_scroll(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let dx = args["dx"].as_i64().unwrap_or(0);
    let dy = args["dy"].as_i64().unwrap_or(600);
    let (x, y) = if ref_of(args).is_some()
        || args["selector"].as_str().is_some()
        || args["text"].as_str().is_some()
    {
        let node = resolve_node(d, args)?;
        element_point(d, &node)?
    } else {
        // Scroll the middle of the viewport (same behaviour as the panel's wheel).
        match d.eval("JSON.stringify([window.innerWidth/2, window.innerHeight/2])", false) {
            Ok(v) => {
                let parsed: Value = serde_json::from_str(v.as_str().unwrap_or("[0,0]"))
                    .unwrap_or_else(|_| json!([0, 0]));
                (
                    parsed[0].as_f64().unwrap_or(0.0) as i64,
                    parsed[1].as_f64().unwrap_or(0.0) as i64,
                )
            }
            Err(_) => (400, 300),
        }
    };
    let conn = &d.conn;
    conn.call(
        "Input.dispatchMouseEvent",
        json!({"type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy}),
    )?;
    Ok(json!({"text": format!("Scrolled by ({dx}, {dy})")}))
}

fn op_resize(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let width = args["width"].as_u64().unwrap_or(1280).clamp(200, 4096) as u32;
    let height = args["height"].as_u64().unwrap_or(800).clamp(200, 4096) as u32;
    {
        let conn = &d.conn;
        conn.call(
            "Emulation.setDeviceMetricsOverride",
            json!({"width": width, "height": height, "deviceScaleFactor": 1, "mobile": false}),
        )?;
    }
    // Keep the panel's own viewport in sync, so the ruler and the frames agree.
    let chat = d.chat.clone();
    let _ = crate::browser::set_viewport(width, height, &chat);
    Ok(json!({"text": format!("Viewport is now {width}x{height}")}))
}

fn op_emulate_media(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let mut features = Vec::new();
    if let Some(scheme) = args["colorScheme"].as_str() {
        features.push(json!({"name": "prefers-color-scheme", "value": scheme}));
    }
    if let Some(motion) = args["reducedMotion"].as_str() {
        features.push(json!({"name": "prefers-reduced-motion", "value": motion}));
    }
    if let Some(contrast) = args["forcedColors"].as_str() {
        features.push(json!({"name": "forced-colors", "value": contrast}));
    }
    if features.is_empty() {
        return Err(
            "emulate_media needs colorScheme, reducedMotion or forcedColors".to_string(),
        );
    }
    let media = args["media"].as_str().unwrap_or("screen");
    let conn = &d.conn;
    conn.call(
        "Emulation.setEmulatedMedia",
        json!({"media": media, "features": features}),
    )?;
    Ok(json!({"text": format!("Emulated media: {media} with {features:?}")}))
}

fn op_handle_dialog(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let accept = args["accept"].as_bool().unwrap_or(false);
    let prompt = args["promptText"].as_str().unwrap_or_default().to_string();
    if let Ok(mut policy) = d.conn.dialog.lock() {
        *policy = (accept, prompt.clone());
    }
    // Try to answer a dialog that is ALREADY open (the policy above covers the
    // next one).
    let conn = &d.conn;
    let replied = conn
        .call(
            "Page.handleJavaScriptDialog",
            json!({"accept": accept, "promptText": prompt}),
        )
        .is_ok();
    Ok(json!({
        "text": if replied {
            format!("Answered the open dialog ({}). Future dialogs will be {}.",
                if accept { "accepted" } else { "dismissed" },
                if accept { "accepted" } else { "dismissed" })
        } else {
            format!("Policy set: future dialogs will be {}.",
                if accept { "accepted" } else { "dismissed" })
        }
    }))
}

fn op_file_upload(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = args["paths"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if paths.is_empty() {
        return Err("file_upload needs `paths` (absolute file paths)".to_string());
    }
    for p in &paths {
        if !std::path::Path::new(p).is_file() {
            return Err(format!("no such file: {p}"));
        }
    }
    let node = resolve_node(d, args)?;
    {
        let conn = &d.conn;
        conn.call(
            "DOM.setFileInputFiles",
            json!({"files": paths, "objectId": node}),
        )?;
    }
    Ok(json!({
        "text": format!("Attached {} file(s) to the file input.", paths.len())
    }))
}

fn op_drag(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let from = resolve_node(d, args)?;
    let (fx, fy) = element_point(d, &from)?;
    // The destination may be given as `to_ref` / `to_selector` / `to_text`.
    let mut to_args = json!({});
    for (dst, src) in [
        ("ref", "to_ref"),
        ("selector", "to_selector"),
        ("text", "to_text"),
    ] {
        if let Some(v) = args.get(src) {
            if !v.is_null() {
                to_args[dst] = v.clone();
            }
        }
    }
    let to = resolve_node(d, &to_args)?;
    let (tx, ty) = element_point(d, &to)?;
    mouse(
        d,
        "mouseMoved",
        fx,
        fy,
        json!({"button": "none", "buttons": 0}),
    )?;
    mouse(
        d,
        "mousePressed",
        fx,
        fy,
        json!({"button": "left", "clickCount": 1, "buttons": 1}),
    )?;
    let steps = 8;
    for i in 1..=steps {
        let x = fx + (tx - fx) * i / steps;
        let y = fy + (ty - fy) * i / steps;
        mouse(
            d,
            "mouseMoved",
            x,
            y,
            json!({"button": "left", "buttons": 1}),
        )?;
        std::thread::sleep(Duration::from_millis(30));
    }
    mouse(
        d,
        "mouseReleased",
        tx,
        ty,
        json!({"button": "left", "clickCount": 1, "buttons": 0}),
    )?;
    Ok(json!({"text": format!("Dragged ({fx}, {fy}) → ({tx}, {ty})")}))
}

fn op_tabs(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let action = args["action"].as_str().unwrap_or("list");
    match action {
        "list" => {}
        "new" => {
            let url = args["url"].as_str().unwrap_or("about:blank");
            let conn = &d.conn;
            let res = conn.call("Target.createTarget", json!({"url": url}))?;
            let id = res["targetId"]
                .as_str()
                .ok_or_else(|| "createTarget returned no id".to_string())?
                .to_string();
            d.conn.attach(&id)?;
            hooks::set_target(&d.chat, &id);
            d.target = id;
            d.conn.enable_domains();
            return Ok(json!({"text": format!("Opened a new tab on {url}")}));
        }
        "select" | "close" => {}
        other => return Err(format!("unknown tabs action: {other}")),
    }

    let list = {
        let conn = &d.conn;
        conn.call("Target.getTargets", json!({}))?
    };
    let pages: Vec<Value> = list["targetInfos"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|t| t["type"].as_str() == Some("page"))
                .cloned()
                .collect()
        })
        .unwrap_or_default();

    if action == "list" {
        let mut text = String::new();
        for (i, t) in pages.iter().enumerate() {
            let id = t["targetId"].as_str().unwrap_or_default();
            text.push_str(&format!(
                "{}{}. {} — {}\n",
                if id == d.target { "* " } else { "  " },
                i,
                t["title"].as_str().unwrap_or_default(),
                t["url"].as_str().unwrap_or_default()
            ));
        }
        return Ok(json!({
            "text": if text.is_empty() { "No tabs.".to_string() } else { format!("Tabs (* = current):\n{text}") }
        }));
    }

    let index = args["index"].as_u64().unwrap_or(0) as usize;
    let target = pages
        .get(index)
        .and_then(|t| t["targetId"].as_str())
        .ok_or_else(|| format!("no tab at index {index}"))?
        .to_string();
    if action == "select" {
        d.conn.attach(&target)?;
        hooks::set_target(&d.chat, &target);
        d.target = target;
        d.conn.enable_domains();
        return Ok(json!({
            "text": format!("Switched to tab {index} — {}", d.url())
        }));
    }
    {
        let conn = &d.conn;
        let _ = conn.call("Target.closeTarget", json!({"targetId": target}));
    }
    if target == d.target {
        // The current tab is gone: the driver will re-attach on the next call.
        return Ok(json!({
            "text": format!("Closed tab {index} (it was the current tab; the next call re-attaches).")
        }));
    }
    Ok(json!({"text": format!("Closed tab {index}")}))
}

fn op_status(d: &mut Driver) -> Result<Value, String> {
    let url = d.url();
    let title = d.title();
    Ok(json!({
        "text": format!("Page: {title}\nURL: {url}"),
        "url": url,
        "title": title,
    }))
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Run one driver operation and render its result as text for the model.
///
/// `op` is the suffix after `browser_` (`navigate`, `snapshot`, `click`, …), so
/// the tool names and the route names come from ONE list.
pub fn run(op: &str, args: &Value, chat_id: &str) -> Result<String, String> {
    // Check the action name FIRST: `with_driver` starts the whole browser when
    // the chat has no tab yet, so validating inside the dispatch below meant a
    // hallucinated tool name launched a Chromium and only then failed —
    // leaving a browser running for a call that could never have worked.
    if !is_known(op) {
        return Err(format!("unknown browser action: {op}"));
    }
    let chat = chat_key(chat_id);
    let value = with_driver(&chat, |d| match op {
        "status" => op_status(d),
        "navigate" => op_navigate(d, args["url"].as_str().unwrap_or_default()),
        "navigate_back" => op_navigate_back(d),
        "snapshot" => op_snapshot(d),
        "click" => op_click(d, args),
        "hover" => op_hover(d, args),
        "type" => op_type(d, args),
        "fill_form" => op_fill_form(d, args),
        "select_option" => op_select_option(d, args),
        "press_key" => op_press_key(d, args),
        "evaluate" => op_evaluate(d, args),
        "wait_for" => op_wait_for(d, args),
        "console_messages" => op_console_messages(d, args),
        "network_requests" => op_network_requests(d, args),
        "find" => op_find(d, args),
        "scroll" => op_scroll(d, args),
        "resize" => op_resize(d, args),
        "emulate_media" => op_emulate_media(d, args),
        "handle_dialog" => op_handle_dialog(d, args),
        "file_upload" => op_file_upload(d, args),
        "drag" => op_drag(d, args),
        "tabs" => op_tabs(d, args),
        other => Err(format!("unknown browser action: {other}")),
    })?;
    let text = value["text"].as_str().unwrap_or_default().to_string();
    Ok(if text.is_empty() {
        serde_json::to_string_pretty(&value).unwrap_or_default()
    } else {
        text
    })
}

/// The operations above, as (TOOL name, description) pairs — the ONE place both
/// the agent's tool schemas and the HTTP routes read, so the two can never drift
/// apart. Names are the full `browser_*` tool names the model calls.
pub const ACTIONS: &[(&str, &str)] = &[
    ("browser_status", "Current page URL and title."),
    ("browser_navigate", "Open a URL in the agent's tab and wait for it to load."),
    ("browser_navigate_back", "Go back in the page's history."),
    (
        "browser_snapshot",
        "Page as a compact list of `[ref] role \"name\"` entries plus its text. Run this before any element action.",
    ),
    ("browser_click", "Click an element by `ref` from a snapshot."),
    ("browser_hover", "Hover an element by `ref`."),
    ("browser_type", "Type text into a field (focus it by `ref`, or the focused element)."),
    ("browser_fill_form", "Fill several fields in one call: `fields: [{ref, value}]`."),
    ("browser_select_option", "Pick an option in a `<select>` by `ref` and `value`."),
    ("browser_press_key", "Press a key or combo, e.g. `Enter`, `Tab`, `Meta+A`."),
    ("browser_evaluate", "Run JavaScript in the page and return its value."),
    ("browser_wait_for", "Wait for text to appear/disappear, or a number of seconds."),
    ("browser_console_messages", "Console logs and uncaught exceptions."),
    ("browser_network_requests", "Requests the page made, with status codes."),
    ("browser_find", "Search the page text and return the matching snippets."),
    ("browser_scroll", "Scroll the page (or a `ref`) by a pixel delta."),
    ("browser_resize", "Set the emulated viewport size."),
    ("browser_emulate_media", "Emulate dark mode / reduced motion / forced colors."),
    ("browser_handle_dialog", "Accept or dismiss the page's next alert/confirm/prompt."),
    ("browser_file_upload", "Attach local files to a file input by `ref`."),
    ("browser_drag", "Drag from `ref` to `to_ref`."),
    ("browser_tabs", "List, open, switch or close tabs."),
];

/// The action half of a tool name (`browser_navigate` → `navigate`).
pub fn action_of(tool: &str) -> Option<&'static str> {
    ACTIONS
        .iter()
        .find(|(n, _)| *n == tool)
        .map(|(n, _)| n.trim_start_matches("browser_"))
}

/// True when `name` is one of the driver's tools.
pub fn handles(name: &str) -> bool {
    ACTIONS.iter().any(|(n, _)| *n == name)
}

/// True when `op` is one of the driver's ACTIONS (the suffix after `browser_`).
///
/// Pure on purpose: `run` checks this BEFORE connecting, so a hallucinated tool
/// name is rejected without starting a Chromium the call could never use.
fn is_known(op: &str) -> bool {
    ACTIONS
        .iter()
        .any(|(n, _)| n.trim_start_matches("browser_") == op)
}

/// Per-action parameters. Actions missing here take no arguments.
fn action_props(action: &str) -> Value {
    match action {
        "navigate" => json!({"url": {"type": "string"}}),
        "click" | "hover" => json!({
            "ref": {"type": "integer"},
            "selector": {"type": "string"},
            "text": {"type": "string"},
            "button": {"type": "string"},
            "click_count": {"type": "integer"},
            "modifiers": {"type": "array", "items": {"type": "string"}},
        }),
        "type" => json!({
            "ref": {"type": "integer"},
            "selector": {"type": "string"},
            "text": {"type": "string"},
            "clear": {"type": "boolean"},
            "submit": {"type": "boolean"},
        }),
        "fill_form" => json!({
            "fields": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "integer"},
                        "selector": {"type": "string"},
                        "value": {"type": "string"}
                    }
                }
            }
        }),
        "select_option" => json!({
            "ref": {"type": "integer"},
            "selector": {"type": "string"},
            "value": {"type": "string"}
        }),
        "press_key" => json!({
            "key": {"type": "string"},
            "modifiers": {"type": "array", "items": {"type": "string"}}
        }),
        "evaluate" => json!({"expression": {"type": "string"}}),
        "wait_for" => json!({
            "text": {"type": "string"},
            "text_gone": {"type": "string"},
            "time": {"type": "number"},
            "timeout": {"type": "integer"}
        }),
        "console_messages" => json!({
            "level": {"type": "string", "description": "info|warning|error"},
            "clear": {"type": "boolean"}
        }),
        "network_requests" => json!({
            "filter": {"type": "string"},
            "clear": {"type": "boolean"}
        }),
        "find" => json!({"text": {"type": "string"}}),
        "scroll" => json!({
            "ref": {"type": "integer"},
            "selector": {"type": "string"},
            "dx": {"type": "integer"},
            "dy": {"type": "integer"}
        }),
        "resize" => json!({"width": {"type": "integer"}, "height": {"type": "integer"}}),
        "emulate_media" => json!({
            "colorScheme": {"type": "string"},
            "reducedMotion": {"type": "string"},
            "forcedColors": {"type": "string"},
            "media": {"type": "string"}
        }),
        "handle_dialog" => json!({
            "accept": {"type": "boolean"},
            "promptText": {"type": "string"}
        }),
        "file_upload" => json!({
            "ref": {"type": "integer"},
            "selector": {"type": "string"},
            "paths": {"type": "array", "items": {"type": "string"}}
        }),
        "drag" => json!({
            "ref": {"type": "integer"},
            "selector": {"type": "string"},
            "to_ref": {"type": "integer"},
            "to_selector": {"type": "string"}
        }),
        "tabs" => json!({
            "action": {"type": "string", "description": "list | new | select | close"},
            "index": {"type": "integer"},
            "url": {"type": "string"}
        }),
        _ => json!({}),
    }
}

/// Native agent tools: one per browser action. The app ships its own CDP driver
/// under these names, so no MCP connector is needed for the browser.
pub fn entries() -> Vec<(&'static str, &'static str, Value)> {
    ACTIONS
        .iter()
        .map(|(tool, desc)| {
            (
                *tool,
                *desc,
                action_props(tool.trim_start_matches("browser_")),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_action_has_a_description_and_a_known_name() {
        // The tool schema and the route table are generated from ACTIONS, so a
        // missing description would ship an unusable tool.
        for (name, desc) in ACTIONS {
            assert!(!name.is_empty());
            assert!(!desc.is_empty(), "{name} has no description");
            assert!(
                name.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{name} must be snake_case"
            );
        }
        // No duplicates: two rows with one name would advertise the tool twice.
        let mut names: Vec<&str> = ACTIONS.iter().map(|(n, _)| *n).collect();
        let total = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), total);
    }

    #[test]
    fn a_printed_ref_is_not_an_array_index() {
        // Regression: refs are monotonic across snapshots, so the FIRST ref of a
        // later snapshot is not `entries[0]`'s index. Reading the ref directly as
        // an index made ref [1] resolve to the SECOND element — the live test
        // clicked the input instead of the button because of exactly this.
        assert_eq!(ref_index(1, 2, 1), Some(0)); // first ref -> first entry
        assert_eq!(ref_index(1, 2, 2), Some(1));
        assert_eq!(ref_index(3, 2, 3), Some(0)); // later snapshot: base 3, ref 3
        assert_eq!(ref_index(3, 2, 4), Some(1));
        // A ref beyond this snapshot's range belongs to a NEWER one.
        assert_eq!(ref_index(3, 2, 5), None);
        // A ref below the base belongs to an OLDER snapshot.
        assert_eq!(ref_index(5, 2, 3), None);
        // Empty snapshot hands out nothing.
        assert_eq!(ref_index(7, 0, 7), None);
    }

    #[test]
    fn refs_parse_in_every_spelling_the_model_uses() {        assert_eq!(ref_of(&json!({"ref": 7})), Some(7));
        assert_eq!(ref_of(&json!({"ref": "7"})), Some(7));
        assert_eq!(ref_of(&json!({"ref": "@7"})), Some(7));
        assert_eq!(ref_of(&json!({"ref": "e7"})), Some(7));
        assert_eq!(ref_of(&json!({"ref": "ref=7"})), None);
        assert_eq!(ref_of(&json!({})), None);
    }

    #[test]
    fn modifiers_map_to_the_cdp_bitmask() {
        assert_eq!(modifier_bits(&json!({"modifiers": ["Alt"]})), 1);
        assert_eq!(modifier_bits(&json!({"modifiers": ["Control"]})), 2);
        assert_eq!(modifier_bits(&json!({"modifiers": ["Meta"]})), 4);
        assert_eq!(modifier_bits(&json!({"modifiers": ["Shift"]})), 8);
        assert_eq!(
            modifier_bits(&json!({"modifiers": ["Meta", "Shift"]})),
            12
        );
        assert_eq!(modifier_bits(&json!({})), 0);
        // Unknown names are ignored rather than turning into a stray bit.
        assert_eq!(modifier_bits(&json!({"modifiers": ["hyper"]})), 0);
    }

    #[test]
    fn named_and_character_keys_resolve_to_cdp_triples() {
        assert_eq!(key_triple("Enter").unwrap().0, 13);
        assert_eq!(key_triple("escape").unwrap().1, "Escape");
        assert_eq!(key_triple("PageDown").unwrap().0, 34);
        let (code, key, dom) = key_triple("a").unwrap();
        assert_eq!((code, key.as_str(), dom.as_str()), (65, "a", "KeyA"));
        let (code, _, dom) = key_triple("5").unwrap();
        assert_eq!((code, dom.as_str()), (53, "Digit5"));
        assert!(key_triple("F13").is_none());
        assert!(key_triple("").is_none());
    }

    #[test]
    fn stale_errors_are_the_only_ones_that_reconnect() {
        assert!(is_stale("the browser connection is closed"));
        assert!(is_stale("cdp error: No target with given id found"));
        assert!(is_stale("Session with given id not found."));
        // A command-level failure must NOT throw the connection away.
        assert!(!is_stale("element not found (null)"));
        assert!(!is_stale("node is not an element"));
        assert!(!is_stale("cdp Input.dispatchMouseEvent timed out"));
    }

    #[test]
    fn a_snapshot_signature_changes_with_the_page() {
        let a = json!({
            "url": "https://x/",
            "title": "X",
            "entries": [{"role": "button", "name": "Save", "x": 1, "y": 2}],
            "text": "hello",
        });
        let b = json!({
            "url": "https://x/",
            "title": "X",
            "entries": [{"role": "button", "name": "Save", "x": 1, "y": 2}],
            "text": "hello",
        });
        let c = json!({
            "url": "https://x/",
            "title": "X",
            "entries": [{"role": "button", "name": "Dele", "x": 1, "y": 2}],
            "text": "hello",
        });
        assert_eq!(signature(&a), signature(&b));
        assert_ne!(signature(&a), signature(&c));
    }

    #[test]
    fn unknown_actions_are_rejected_before_any_browser_is_started() {
        // `with_driver` LAUNCHES the browser when the chat has no tab, so the
        // name check must happen first: otherwise a hallucinated tool name
        // spawns a Chromium and only then fails. `is_known` is the pure gate run
        // uses for exactly that reason, so it is asserted directly here instead
        // of by calling `run` (which would start a real browser on the valid
        // path and make the test depend on the machine).
        assert!(is_known("navigate"));
        assert!(is_known("snapshot"));
        assert!(is_known("tabs"));
        assert!(!is_known("teleport"));
        assert!(!is_known(""));
        assert!(!is_known("browser_navigate"));
        // Every advertised action must pass the gate, or the tool is unusable.
        for (name, _) in ACTIONS {
            assert!(is_known(name.trim_start_matches("browser_")), "{name}");
        }
    }

    #[test]
    fn the_tool_name_the_action_name_and_the_schema_agree() {
        // Three surfaces are generated from ACTIONS (tool name, `action_of`
        // suffix, schema properties). A row that one of them misses ships a tool
        // the dispatcher cannot route, so the correspondence is asserted.
        for (name, _) in ACTIONS {
            let action = action_of(name).unwrap_or_else(|| panic!("action_of({name})"));
            assert!(handles(name));
            assert_eq!(
                action,
                name.trim_start_matches("browser_"),
                "{name} disagrees with its action"
            );
            let props = action_props(action);
            assert!(
                props.is_object(),
                "{action} must map to a properties object"
            );
            // An action with no parameters at all is legitimate (status,
            // navigate_back, snapshot), so only the shape is checked.
        }
        assert!(action_of("browser_teleport").is_none());
        assert!(!handles("teleport"));
    }

    #[test]
    fn an_unknown_action_is_rejected_by_name() {
        let err = run("teleport", &json!({}), "no-such-chat").unwrap_err();
        assert!(err.contains("unknown browser action"), "{err}");
    }

    /// End-to-end against a REAL Chromium: navigate, snapshot for refs, click a
    /// ref, type into a ref, read a value back. Ignored by default because it
    /// starts a browser and needs one installed; run with
    /// `cargo test --bin codifa -- --ignored live_driver_drives_a_real_page`.
    #[test]
    #[ignore]
    fn live_driver_drives_a_real_page() {
        let chat = format!("live-{}", std::process::id());
        let page = "data:text/html,<title>T</title><body>\
            <button id=b onclick=\"this.textContent='Clicked'\">Go</button>\
            <input id=i aria-label=\"Name\">\
            <div id=out></div></body>";
        let nav = run("navigate", &json!({"url": page}), &chat).expect("navigate");
        assert!(!nav.is_empty());

        let snap = run("snapshot", &json!({}), &chat).expect("snapshot");
        assert!(snap.contains("[1]"), "snapshot handed out no refs: {snap}");

        // The button's ref is the one whose line names the button. Match the
        // REF LINE specifically: the page URL is echoed above the list and also
        // contains the handler's source text, so a looser match picked the URL
        // line (which carries no ref) and failed the parse.
        let button_ref = snap
            .lines()
            .find(|l| l.starts_with("- [") && l.contains("button"))
            .and_then(|l| l.split('[').nth(1))
            .and_then(|r| r.split(']').next())
            .and_then(|r| r.parse::<i64>().ok())
            .expect("no ref for the button");

        let clicked = run("click", &json!({"ref": button_ref}), &chat).expect("click");
        assert!(!clicked.is_empty());

        let after = run("evaluate", &json!({"expression": "document.body.innerText"}), &chat)
            .expect("evaluate");
        assert!(
            after.contains("Clicked"),
            "the click did not fire the handler: {after}"
        );

        // Typing goes through a ref too.
        run("type", &json!({"selector": "#i", "text": "hello"}), &chat).expect("type");
        let value = run(
            "evaluate",
            &json!({"expression": "document.querySelector('#i').value"}),
            &chat,
        )
        .expect("read back");
        assert!(value.contains("hello"), "typed text did not land: {value}");
    }
}
