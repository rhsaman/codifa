use super::*;

#[derive(serde::Deserialize)]
pub(super) struct EventsHello {
    #[serde(default)]
    roots: Vec<String>,
}

pub(super) async fn events_ws(ws: WebSocketUpgrade) -> Response<Body> {
    ws.on_upgrade(events_socket)
}

pub(super) async fn events_socket(mut socket: WebSocket) {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut roots: Vec<String> = Vec::new();
    let mut fps: HashMap<String, u64> = HashMap::new();
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(1500));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            msg = socket.recv() => {
                match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        if let Ok(hello) = serde_json::from_str::<EventsHello>(&text) {
                            if hello.roots != roots {
                                roots = hello.roots;
                                fps.clear();
                            }
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => return,
                    Some(Err(_)) => return,
                    _ => {}
                }
            }
            _ = tick.tick() => {
                for root in roots.clone() {
                    let Ok(out) = tokio::process::Command::new("git")
                        .args(["status", "--porcelain=v1", "-b", "--untracked-files=all"])
                        .current_dir(&root)
                        .output()
                        .await
                    else {
                        continue;
                    };
                    if !out.status.success() {
                        continue;
                    }
                    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
                    let mut hasher = DefaultHasher::new();
                    stdout.hash(&mut hasher);
                    let fp = hasher.finish();
                    if fps.get(&root) == Some(&fp) {
                        continue;
                    }
                    fps.insert(root.clone(), fp);
                    // porcelain lines: "XY path" (renames: "XY old -> new" → new).
                    // The leading "## branch" summary line is not a path.
                    let files: Vec<String> = stdout
                        .lines()
                        .filter(|l| l.len() > 3 && !l.starts_with("## "))
                        .map(|l| {
                            let p = &l[3..];
                            match p.split_once(" -> ") {
                                Some((_, new)) => new.trim_matches('"').to_string(),
                                None => p.trim_matches('"').to_string(),
                            }
                        })
                        .collect();
                    let payload = json!({"kind": "change", "root": root, "files": files});
                    if socket
                        .send(WsMessage::Text(payload.to_string()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
    }
}

