//! Live-test backend: serves the REAL router (`backend_light::router`) on a
//! free port, over any data root, with no Tauri app running.
//!
//! Usage:
//!     cargo run --example backend_live                       # real ~/.codifa
//!     CODER_DATA_DIR=/tmp/codifa-ui-live cargo run --example backend_live
//!
//! Prints "PORT=<port>" on stdout once the listener is up — the driver polls
//! this line before pointing the UI harness at the server. The scheduler loop
//! is intentionally NOT started: a manual `POST /schedules/:id/run` still
//! spawns and executes the run (that path type-checks against the real
//! executor), but no cron tick ever flips a task on its own — a test run
//! cannot fire a task behind the test's back.
//!
//! `--mock-provider`: also spawn a local OpenAI-compatible upstream and write
//! a settings.json providing it, so `POST /schedules/:id/run` executes a REAL
//! agent turn against a fixed completion — no network, no API key, no cost.

use std::path::PathBuf;

#[tokio::main]
async fn main() {
    // The same CODER_DATA_DIR override the app itself honors, so a test can
    // point the whole backend at a scratch root without touching real data.
    let root = std::env::var("CODER_DATA_DIR")
        .ok()
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().map(|h| h.join(".codifa")).unwrap_or_default());
    std::fs::create_dir_all(&root).expect("data root");

    // `--mock-provider`: a fixed OpenAI-compatible completion on 127.0.0.1, wired
    // into settings.json so a scheduled run's provider chain resolves to it.
    if std::env::args().any(|a| a == "--mock-provider") {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind mock upstream");
        let base = format!(
            "http://{}",
            listener.local_addr().expect("mock addr")
        );
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    // (start, end) of the body inside `buf`: the header end and
                    // header end + Content-Length.(HTTP/1.1: the client keeps
                    // its write side open until it sees the response, so reading
                    // to EOF deadlocks — read exactly to the announced end.)
                    let (body_start, body_end) = loop {
                        let n = sock.read(&mut tmp).await.unwrap_or(0);
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..p]);
                            let len: usize = head
                                .lines()
                                .find_map(|l| {
                                    let (k, v) = l.split_once(':')?;
                                    k.eq_ignore_ascii_case("content-length")
                                        .then(|| v.trim().parse().ok())?
                                })
                                .unwrap_or(0);
                            break (p + 4, p + 4 + len);
                        }
                        if buf.len() > 512 * 1024 {
                            break (buf.len(), buf.len());
                        }
                    };
                    // Drain any body tail still on the wire up to body_end.
                    while buf.len() < body_end {
                        let n = sock.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    // Record EVERY request body under the data root, numbered:
                    // the agent probes (models list, …) share the same port and
                    // a body-less probe must not clobber the turn's body the
                    // live test asserts on. This name keeps the LAST NON-EMPTY
                    // body for convenience assertions.
                    if buf.len() >= body_end {
                        let body_path = std::env::var("CODER_DATA_DIR")
                            .unwrap_or_else(|_| "/tmp/codifa-ui-live".into());
                        let body = &buf[body_start.min(buf.len())..body_end.min(buf.len())];
                        static REQ_NO: std::sync::atomic::AtomicUsize =
                            std::sync::atomic::AtomicUsize::new(0);
                        let n = REQ_NO.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let _ = std::fs::write(
                            format!("{body_path}/mock_req_{n:03}.json"),
                            body,
                        );
                        if !body.is_empty() {
                            let _ = std::fs::write(
                                format!("{body_path}/mock_last_request.json"),
                                body,
                            );
                        }
                    }
                    // The agent's `custom` kind asks for SSE (`stream: true`):
                    // answer with the same delta frames the real gateways send.
                    let sse = concat!(
                        r#"data: {"choices":[{"delta":{"content":"mock schedule run completed successfully"}}]}"#,
                        "\n\n",
                        r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":21,"completion_tokens":7}}"#,
                        "\n\n",
                        "data: [DONE]\n\n"
                    );
                    let mut resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{sse}",
                        sse.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.flush().await;
                    let _ = &mut resp;
                });
            }
        });
        // The provider row uses the SAME shape the renderer writes (id/kind/
        // model/baseUrl), so `resolve_provider` and the rung builder see a
        // provider that looks exactly like a real one.
        let settings = serde_json::json!({
            "providers": [{
                "id": "mock-live",
                "kind": "custom",
                "label": "Mock Live",
                "model": "mock-model",
                "baseUrl": base,
                "apiKey": "mock-key",
            }]
        });
        std::fs::write(
            root.join("settings.json"),
            serde_json::to_vec_pretty(&settings).expect("settings json"),
        )
        .expect("write settings.json");
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind 127.0.0.1:0");
    let port = listener.local_addr().expect("local addr").port();
    println!("PORT={port}");

    let state = codifa::backend_light::new_state(root);
    axum::serve(listener, codifa::backend_light::router(state))
        .await
        .expect("serve");
}
