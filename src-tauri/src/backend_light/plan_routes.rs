use super::*;

#[derive(serde::Deserialize)]
pub(super) struct PlanSaveBody {
    root: String,
    #[serde(default)]
    chat_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    content: String,
}

pub(super) async fn plan_get(State(st): State<AppState>, Query(q): Query<PlanQuery>) -> Response<Body> {
    let ws = crate::plans::workspace_slug_for_root(&q.root);
    match crate::plans::get_plan(&st.root().to_string_lossy(), &ws, &q.chat_id) {
        Some(p) => Json(p).into_response(),
        None => (StatusCode::NOT_FOUND, "no plan").into_response(),
    }
}

pub(super) async fn plan_save(State(st): State<AppState>, Json(body): Json<PlanSaveBody>) -> Response<Body> {
    if body.root.trim().is_empty() {
        return bad_request("root is required");
    }
    let ws = crate::plans::workspace_slug_for_root(&body.root);
    match crate::plans::save_plan(
        &st.root().to_string_lossy(),
        &ws,
        &body.title,
        &body.content,
        &body.chat_id,
    ) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => bad_request(&e),
    }
}

pub(super) async fn plan_delete(State(st): State<AppState>, Query(q): Query<PlanQuery>) -> Response<Body> {
    let ws = crate::plans::workspace_slug_for_root(&q.root);
    let removed = crate::plans::delete_plan(&st.root().to_string_lossy(), &ws, &q.chat_id);
    Json(json!({"ok": true, "removed": removed})).into_response()
}

pub(super) async fn plan_checklist_get(State(st): State<AppState>, Query(q): Query<PlanQuery>) -> Response<Body> {
    let ws = crate::plans::workspace_slug_for_root(&q.root);
    Json(json!({
        "items": crate::plans::get_checklist(&st.root().to_string_lossy(), &ws, &q.chat_id)
    }))
    .into_response()
}

pub(super) async fn plan_checklist_save(
    State(st): State<AppState>,
    Json(body): Json<PlanChecklistBody>,
) -> Response<Body> {
    if body.root.trim().is_empty() {
        return bad_request("root is required");
    }
    let ws = crate::plans::workspace_slug_for_root(&body.root);
    crate::plans::save_checklist(
        &st.root().to_string_lossy(),
        &ws,
        &body.chat_id,
        &body.items,
    );
    Json(json!({"ok": true})).into_response()
}

/// POST /ask/respond — answer a pending `ask_user` gate.
///
/// The agent turn is parked on a oneshot inside `agent::await_answer`; this
/// resolves it and lets the turn continue. `answer` may be a chosen option or
/// free text. Every failure mode is a plain `{"ok": false}` — a stale or
/// duplicate answer must never break the renderer.
pub(super) async fn ask_respond(Json(body): Json<Value>) -> Response<Body> {
    let id = body["id"].as_str().unwrap_or("").trim().to_string();
    if id.is_empty() {
        return bad_request("id is required");
    }
    let answer = body["answer"].as_str().unwrap_or("").trim().to_string();
    let ok = crate::agent::deliver_answer(&id, json!({ "answer": answer }));
    Json(json!({ "ok": ok })).into_response()
}

/// POST /permission/respond — approve/deny a pending confirm_action gate.
///
/// The action is NOT performed by the tool until `allowed` is true, so a denied
/// request returns a "do not do it" tool result to the model instead.
pub(super) async fn permission_respond(Json(body): Json<Value>) -> Response<Body> {
    let id = body["id"].as_str().unwrap_or("").trim().to_string();
    if id.is_empty() {
        return bad_request("id is required");
    }
    let allowed = body["allowed"].as_bool().unwrap_or(false);
    let ok = crate::agent::deliver_answer(&id, json!({ "allowed": allowed }));
    Json(json!({ "ok": ok })).into_response()
}

/// POST /permission/trust — persist an "Always allow" folder grant.
///
/// The popup's "Always allow" only updated the renderer's in-memory list, so the
/// SAME folder was asked for again after every relaunch and workspace switch.
/// This writes the canonical path into `<data-root>/trusted-folders.json`, which
/// `outside_permit` merges into every later turn — interactive AND scheduled.
pub(super) async fn permission_trust(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    let folder = body["folder"].as_str().unwrap_or("").trim().to_string();
    if folder.is_empty() {
        return bad_request("folder is required");
    }
    let root = st.root().to_string_lossy().to_string();
    match crate::agent::add_trusted_folder(&root, &folder) {
        Ok(stored) => Json(json!({ "ok": true, "folder": stored })).into_response(),
        Err(e) => bad_request(&e),
    }
}

/// POST /permission/trust-host — persist an "Always allow" SSH host grant.
///
/// The SSH connection gate (`agent::ask_ssh_access`) reads
/// `<data-root>/trusted-hosts.json` on every `run_terminal` call, so a host
/// approved here never prompts again — the SSH counterpart of the folder
/// grant above.
pub(super) async fn permission_trust_host(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    let host = body["host"].as_str().unwrap_or("").trim().to_string();
    if host.is_empty() {
        return bad_request("host is required");
    }
    let root = st.root().to_string_lossy().to_string();
    match crate::agent::add_trusted_host(&root, &host) {
        Ok(stored) => Json(json!({ "ok": true, "host": stored })).into_response(),
        Err(e) => bad_request(&e),
    }
}

#[derive(serde::Deserialize)]
pub(super) struct PlanQuery {
    root: String,
    #[serde(default)]
    chat_id: String,
}

// ---------- agent background terminals ----------
// The right panel's Terminals section polls the live list for the ACTIVE chat
// (the section exists only while something runs) and posts a Stop here — the
// same loopback surface every other panel uses, no Tauri-event plumbing.

#[derive(serde::Deserialize)]
pub(super) struct AgentTerminalsQuery {
    #[serde(default)]
    chat_id: String,
}

pub(super) async fn agent_terminals_list(Query(q): Query<AgentTerminalsQuery>) -> Response<Body> {
    Json(json!({
        "terminals": crate::agent_terminals::list(&q.chat_id),
    }))
    .into_response()
}

#[derive(serde::Deserialize)]
pub(super) struct AgentTerminalStopBody {
    #[serde(default)]
    id: String,
}

pub(super) async fn agent_terminals_stop(Json(body): Json<AgentTerminalStopBody>) -> Response<Body> {
    if body.id.trim().is_empty() {
        return bad_request("id is required");
    }
    Json(json!({ "ok": crate::agent_terminals::stop(body.id.trim()) })).into_response()
}

#[derive(serde::Deserialize)]
pub(super) struct PlanChecklistBody {
    root: String,
    #[serde(default)]
    chat_id: String,
    #[serde(default)]
    items: Value,
}

// ---------- (proxy removed: the Python sidecar is gone) ----------


