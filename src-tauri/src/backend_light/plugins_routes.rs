use super::*;

// ---------- skills / mcp (native) + system-prompts (native appstate) ----------

pub(super) async fn skills_list(State(st): State<AppState>) -> Response<Body> {
    // Every skill there is, from every bundle, enabled or not — a skill has no
    // store of its own any more, so this IS the list Settings edits.
    Json(json!({ "skills": crate::plugins::all_plugin_skills(&st.root()) })).into_response()
}

/// Every skill the agent can actually load: the standalone store PLUS the
/// skills of every ENABLED plugin (`skill_router::load_skills` — the same call
/// the prompt catalog is built from).
///
/// Kept off `/skills` on purpose: Settings edits and deletes whatever that
/// route returns, and a plugin's skill belongs to its bundle (it disappears
/// with the plugin). This route exists so the composer can offer a plugin skill
/// as its own `/`-command — the name the plugin's install message tells the
/// user to type.
pub(super) async fn skills_available(State(st): State<AppState>) -> Response<Body> {
    let root = st.root();
    let rows = crate::skill_router::load_skills(&root.to_string_lossy());
    Json(json!({ "skills": rows })).into_response()
}

#[derive(serde::Deserialize)]
pub(super) struct SkillFileQuery {
    name: String,
    file: String,
}

pub(super) async fn skills_file(State(st): State<AppState>, Query(q): Query<SkillFileQuery>) -> Response<Body> {
    let root = st.root();
    let read = match crate::plugins::skill_dir_for(&root, &q.name) {
        Some(dir) => skills::read_extra_file(&dir, &q.name, &q.file),
        None => Err(format!("skill not found: {}", q.name)),
    };
    match read {
        Ok(v) => Json(v).into_response(),
        // JSON `detail` like every other native error: the renderer reads that
        // key, so a plain-text body would be replaced by a generic message.
        Err(msg) => (StatusCode::NOT_FOUND, Json(json!({ "detail": msg }))).into_response(),
    }
}

pub(super) async fn skills_sync(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    // A skill lives inside a bundle (its own when it is new), so the writer owns
    // the routing: it finds the owning bundle — matched on the new name AND the
    // previous one so a rename stays put — instead of the caller naming a store.
    let root = st.root();
    if body["delete"].as_bool().unwrap_or(false) {
        let name = body["name"].as_str().unwrap_or("");
        return match crate::plugins::delete_bundle_skill(&root, name) {
            Ok(v) => Json(v).into_response(),
            Err(msg) => bad_request(&msg),
        };
    }
    match crate::plugins::save_bundle_skill(&root, body.clone()) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

/// Every skill of every plugin, enabled or not, tagged with its owning plugin.
///
/// `/skills/available` deliberately returns only what the agent can load RIGHT
/// NOW, so Settings needed a second source to show (and edit) a switched-off
/// bundle's contents.
pub(super) async fn plugins_skills(State(st): State<AppState>) -> Response<Body> {
    Json(json!({ "skills": crate::plugins::all_plugin_skills(&st.root()) })).into_response()
}

/// Every connector that exists, tagged with its owning bundle.
///
/// A connector belongs to a bundle (one of its own when it was written alone), so
/// this is the single list Settings and the composer read — there is no second
/// connector store to merge with.
pub(super) async fn plugins_mcp(State(st): State<AppState>) -> Response<Body> {
    Json(json!({ "connectors": crate::plugins::all_plugin_connectors(&st.root()) }))
        .into_response()
}

/// Every script of every plugin, enabled or not, tagged with its owning bundle.
pub(super) async fn plugins_scripts(State(st): State<AppState>) -> Response<Body> {
    Json(json!({ "scripts": crate::plugins::all_plugin_scripts(&st.root()) })).into_response()
}

/// Every slash command of every plugin, tagged with its owning bundle.
pub(super) async fn plugins_commands(State(st): State<AppState>) -> Response<Body> {
    Json(json!({ "commands": crate::plugins::all_plugin_commands(&st.root()) })).into_response()
}

/// Every sub-agent profile of every plugin, tagged with its owning bundle.
pub(super) async fn plugins_agents(State(st): State<AppState>) -> Response<Body> {
    Json(json!({ "agents": crate::plugins::all_plugin_agents(&st.root()) })).into_response()
}

pub(super) async fn plugins_mcp_save(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match crate::plugins::save_bundle_connector(&st.root(), &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

pub(super) async fn plugins_mcp_delete(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match crate::plugins::delete_bundle_connector(&st.root(), &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

// ---------- plugins (skills + connectors as one switchable bundle) ----------

pub(super) async fn plugins_list(State(st): State<AppState>) -> Response<Body> {
    Json(crate::plugins::list_plugins(&st.root())).into_response()
}

/// Query of `GET /plugins/marketplace`: the same three arguments an install
/// takes, so the address a browse used is exactly the one a later install (and
/// an "update from source") repeats.
#[derive(serde::Deserialize)]
pub(super) struct MarketplaceQuery {
    repo: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    git_ref: String,
    /// Skip a still-fresh disk copy (the explicit Refresh button).
    #[serde(default, deserialize_with = "query_bool")]
    refresh: bool,
}

/// A query-string bool that also reads `1`/`0` (and `yes`/`on`).
///
/// axum's default `bool` only accepts `true`/`false`, so a client sending
/// `?refresh=1` — the shape this endpoint used to be called with — failed
/// deserialization with a bare 400 before the read even started, and the
/// Marketplaces tab reported an error on every chip click and Refresh.
pub(super) fn query_bool<'de, D>(d: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = <String as serde::Deserialize>::deserialize(d)?;
    match raw.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" | "" => Ok(false),
        other => Err(serde::de::Error::custom(format!(
            "expected a bool, got `{other}`"
        ))),
    }
}

pub(super) async fn plugins_create(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match crate::plugins::create_plugin(&st.root(), &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

pub(super) async fn plugins_update(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match crate::plugins::update_plugin(&st.root(), &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

pub(super) async fn plugins_toggle(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match crate::plugins::toggle_plugin(&st.root(), &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

pub(super) async fn plugins_delete(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match crate::plugins::delete_plugin(&st.root(), &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

/// Run one MCP tool on behalf of a trusted surface (the artifact panel).
///
/// The caller names a TOOL, never a server: the connector list is resolved here
/// from what the user has enabled, so a generated page cannot reach a connector
/// that is switched off, and it never sees a token or a command line. MCP calls
/// speak a child process or the network, so this stays off the async worker.
pub(super) async fn mcp_call(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    let root = st.root();
    match tokio::task::spawn_blocking(move || {
        let tool = body["tool"].as_str().unwrap_or("").trim();
        if tool.is_empty() {
            return Err("an MCP tool name is required".to_string());
        }
        let args = body.get("args").cloned().unwrap_or_else(|| json!({}));
        // Same resolution the agent uses for a turn: the connectors the renderer
        // says are enabled win, and plugin-shipped ones fill the rest. The
        // caller cannot name a server, only a tool, so this list IS the whole
        // reachable surface.
        let mut servers = crate::plugins::enabled_connectors(&root);
        if let Some(own) = body["servers"].as_object() {
            for (name, cfg) in own {
                servers.insert(name.clone(), cfg.clone());
            }
        }
        let servers = Value::Object(servers);
        // A bare name is resolved against the enabled set by `call_tool`; the
        // error it returns already names what is available.
        crate::mcp::call_tool(&servers, tool, &args)
    })
    .await
    {
        Ok(Ok(text)) => Json(json!({ "ok": true, "result": text })).into_response(),
        Ok(Err(msg)) => bad_request(&msg),
        Err(e) => bad_request(&format!("the MCP call stopped: {e}")),
    }
}

/// Run one of a plugin's scripts. A Rust script compiles on first use, so this
/// is a blocking task exactly like the repo read an install does.
pub(super) async fn plugins_run(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    let root = st.root();
    match tokio::task::spawn_blocking(move || crate::plugins::run_plugin_script(&root, &body)).await {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(msg)) => bad_request(&msg),
        Err(e) => bad_request(&format!("the script runner stopped: {e}")),
    }
}

/// Install a bundle from a repo. Reading the repo is blocking (git-less HTTP on
/// a plain thread), so the handler stays off the async worker.
/// Read a marketplace INDEX (a repo's plugin catalogue). Read-only: browsing a
/// marketplace writes nothing, so it needs no `spawn_blocking` guard beyond the
/// blocking HTTP read a plain install already does.
pub(super) async fn plugins_marketplace(
    State(st): State<AppState>,
    Query(q): Query<MarketplaceQuery>,
) -> Response<Body> {
    let cache = st.root().join("cache");
    match tokio::task::spawn_blocking(move || {
        crate::repo::read_index_cached(&cache, &q.repo, &q.path, &q.git_ref, q.refresh)
    })
    .await
    {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(msg)) => bad_request(&msg),
        Err(e) => bad_request(&format!("marketplace read failed: {e}")),
    }
}

pub(super) async fn plugins_install(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    // Dispatches on the row's `kind`: a marketplace's Skills tab writes the
    // skills store and its MCP tab writes the connector store, so an installed
    // skill actually shows up under Settings → Skills and an installed connector
    // under Settings → MCP.
    match tokio::task::spawn_blocking(move || {
        crate::plugins::install_from_marketplace(&st.root(), &body)
    })
    .await
    {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(msg)) => bad_request(&msg),
        Err(e) => bad_request(&format!("install failed: {e}")),
    }
}

/// Live install progress for the chat's progress bubble. One slot the install
/// writes as it moves (`listing` → `reading done/total` → `writing`), read as
/// often as the renderer likes — a poll, because the install itself is one
/// blocking POST with no stream to attach to.
pub(super) async fn plugins_install_progress() -> Response<Body> {
    Json(match crate::repo::install_progress_now() {
        Some((phase, done, total)) => json!({ "phase": phase, "done": done, "total": total }),
        None => json!({ "phase": "idle" }),
    })
    .into_response()
}

