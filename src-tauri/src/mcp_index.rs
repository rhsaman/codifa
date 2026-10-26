//! Lazy exposure of MCP connector tools.
//!
//! Measured on a real trace: one enabled Proxmox connector shipped **391 tool
//! schemas (~59K tokens)** on the FIRST model call of the turn — 87% of a 68K
//! opening prompt, billed as uncached input because nothing preceded it in the
//! prefix. The user had not touched Proxmox at all that session.
//!
//! The root cause is not the schema TEXT, it is that the whole catalogue of
//! every enabled connector was inlined unconditionally, on every turn, whether
//! or not the turn had anything to do with that connector.
//!
//! So connectors are exposed the way skills are: the system prompt carries a
//! one-line-per-connector INDEX (name + tool count + a few tool names), and the
//! connector's real schemas are only appended to the tool array once the turn
//! declares it needs them, through the `use_mcp` tool.
//!
//! The split is deliberately per-TURN, never per-round: the tool array must
//! stay byte-identical across the rounds of one turn or the prefix cache breaks
//! from round 2 onward (see `tool_schemas_serialize_byte_identically`).

#[cfg(test)]
use serde_json::Value;

/// One connector as it appears to the model: a name, a count, and a few tools.
///
/// `tools` is the full advertised list — the INDEX only prints a sample of it,
/// but the guard needs the whole set to answer "is this a deferred tool?".
#[derive(Debug, Clone)]
pub struct ConnectorEntry {
    pub server: String,
    pub tools: Vec<String>,
}

/// Parse a JSON-RPC `tools/list` result body into an index entry.
///
/// Used by the mcp tests that exercise the index without a live connector.
#[cfg(test)]
pub fn entries_from_list(server: &str, tools: &[Value]) -> Option<ConnectorEntry> {
    let names: Vec<String> = tools
        .iter()
        .filter_map(|t| t["name"].as_str())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .collect();
    if names.is_empty() {
        return None;
    }
    Some(ConnectorEntry {
        server: server.to_string(),
        tools: names,
    })
}

/// Names shown for one connector in the index before it is truncated.
///
/// Four names are enough for the model to recognise WHAT the connector is about
/// (the point of the index), and the cap keeps a 300-tool connector from
/// re-introducing the very cost this module exists to remove.
const SAMPLE_TOOLS: usize = 4;

/// The system-prompt index: one line per connector, byte-stable per turn.
///
/// Byte-stability matters — this text lands in `messages[0]`, the first byte a
/// prefix cache reuses. Callers pass the connectors already sorted.
pub fn index_section(connectors: &[ConnectorEntry]) -> String {
    if connectors.is_empty() {
        return String::new();
    }
    let mut sorted: Vec<&ConnectorEntry> = connectors.iter().collect();
    sorted.sort_by(|a, b| a.server.cmp(&b.server));

    let mut out = String::from(
        "\n\n=== MCP CONNECTORS (available on demand) ===\n\
         Each connector below is switched on, but its tools are NOT loaded yet: \
         loading every connector's whole catalogue up front costs tens of \
         thousands of tokens on every round trip. To use one, call `use_mcp` \
         with its server name — the tools appear on the NEXT call of this turn.\n",
    );
    for c in sorted {
        let sample: Vec<&str> = c.tools.iter().take(SAMPLE_TOOLS).map(String::as_str).collect();
        let more = c.tools.len().saturating_sub(sample.len());
        out.push_str(&format!(
            "- {} ({} tools): {}{}\n",
            c.server,
            c.tools.len(),
            sample.join(", "),
            if more > 0 {
                format!(", … and {more} more")
            } else {
                String::new()
            }
        ));
    }
    out
}

/// The server that owns `tool`, when the name is unambiguous.
///
/// A bare tool name reaches the loop as-is (mcp.rs collapses the prefix when a
/// name is unique across connectors), so the guard has to map it back to its
/// owner to decide whether it was activated.
pub fn owner_of<'a>(connectors: &'a [ConnectorEntry], tool: &str) -> Option<&'a str> {
    let mut hit: Option<&str> = None;
    for c in connectors {
        if c.tools.iter().any(|t| t == tool) {
            if hit.is_some() {
                // Two connectors claim the name: mcp.rs would have qualified it,
                // so a bare name here is NOT resolvable and must not be guessed.
                return None;
            }
            hit = Some(c.server.as_str());
        }
    }
    hit
}

/// Resolve a `use_mcp` argument to a real server name.
///
/// Accepts the exact server name, any case/space variant of it, and a plain
/// misspelling is NOT guessed — the caller answers with the real list instead,
/// the same way `load_skill` does.
pub fn resolve_server(connectors: &[ConnectorEntry], asked: &str) -> Option<String> {
    let norm = |s: &str| s.trim().to_lowercase().replace(['-', '_', ' '], "");
    let n = norm(asked);
    if n.is_empty() {
        return None;
    }
    connectors
        .iter()
        .find(|c| norm(&c.server) == n)
        .map(|c| c.server.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conn(server: &str, tools: &[&str]) -> ConnectorEntry {
        ConnectorEntry {
            server: server.into(),
            tools: tools.iter().map(|t| t.to_string()).collect(),
        }
    }

    #[test]
    fn a_big_catalogue_costs_a_line_not_a_catalogue() {
        // The whole point: a 300-tool connector (the real Proxmox shape) must
        // cost the index a bounded line, not its schemas. Measured on a trace,
        // the eager form shipped 391 schemas ≈ 236K chars; the index must stay
        // two orders of magnitude below that or the fix has not landed.
        let tools: Vec<String> = (0..300).map(|i| format!("tool_number_{i}")).collect();
        let refs: Vec<&str> = tools.iter().map(String::as_str).collect();
        let section = index_section(&[conn("proxmox", &refs)]);
        assert!(section.contains("proxmox (300 tools)"), "{section}");
        assert!(section.len() < 1000, "index line too long: {}", section.len());
        // Only a SAMPLE of the names is listed — never the whole catalogue.
        assert!(section.contains("and 296 more"), "{section}");
        assert!(!section.contains("tool_number_299"), "{section}");
    }

    #[test]
    fn the_index_is_byte_stable_for_one_turn() {
        // `messages[0]` is the first byte a prefix cache reuses, so the section
        // must not depend on iteration order. Two connectors handed in either
        // order must render identically, or the cache breaks from round 2.
        let a = conn("docker", &["list_containers", "start_vm"]);
        let b = conn("proxmox", &["a", "b"]);
        let first = index_section(&[a.clone(), b.clone()]);
        let second = index_section(&[b, a]);
        assert_eq!(first, second);
    }

    #[test]
    fn an_empty_catalogue_adds_nothing_to_the_prompt() {
        // A turn with no connector switched on must not carry the section — a
        // stray heading would be the "wallpaper" failure this replaced.
        assert!(index_section(&[]).is_empty());
    }

    #[test]
    fn index_names_every_connector_with_its_count() {
        let section = index_section(&[
            conn("docker", &["list_containers", "start_vm"]),
            conn("proxmox", &["a"]),
        ]);
        assert!(section.contains("- docker (2 tools): list_containers, start_vm"));
        assert!(section.contains("- proxmox (1 tools): a"));
        assert!(section.contains("use_mcp"), "{section}");
    }

    #[test]
    fn index_truncates_a_huge_connector_to_a_sample() {
        // The whole point: a 300-tool connector must not print 300 names.
        let many: Vec<String> = (0..300).map(|i| format!("tool_{i}")).collect();
        let entry = ConnectorEntry {
            server: "proxmox".into(),
            tools: many.clone(),
        };
        let section = index_section(&[entry]);
        assert!(section.contains("(300 tools)"), "{section}");
        assert!(section.contains("and 296 more"), "{section}");
        // Only the sample is printed — tool_4 is past the cut and must be absent.
        assert!(!section.contains("tool_4,"), "{section}");
        // For scale: the sample keeps the section tiny next to 300 schemas. The
        // bound covers the fixed explanatory header (~370 chars) plus the sample;
        // it is an ORDER-of-magnitude gate against re-inlining, not a tight fit.
        assert!(section.len() < 420, "index must stay a line, got {}", section.len());
    }

    #[test]
    fn index_is_empty_without_connectors() {
        assert!(index_section(&[]).is_empty());
    }

    #[test]
    fn entries_skip_a_connector_with_no_named_tools() {
        assert!(entries_from_list("x", &[json!({"name": "  "})]).is_none());
        assert!(entries_from_list("x", &[]).is_none());
        let e = entries_from_list("x", &[json!({"name": "ping"})]).unwrap();
        assert_eq!(e.tools, vec!["ping"]);
    }

    #[test]
    fn a_switched_off_connector_is_invisible_and_cannot_be_activated() {
        // The enabled map is the source of truth. A connector that is OFF is
        // never discovered, so it gets no schema and no index line — and this is
        // the behaviour that made "proxmox was in my prompt but I never used it"
        // impossible to explain. `resolve_server` is the LAST gate: even a model
        // that guesses the name of an off connector must not be able to load it.
        let on = vec![conn("docker", &["list_containers"])];
        // The index only ever names what was discovered.
        let section = index_section(&on);
        assert!(section.contains("docker"), "{section}");
        assert!(!section.contains("proxmox"), "{section}");
        // …and the off one is not resolvable, so `use_mcp` cannot reach it.
        assert_eq!(resolve_server(&on, "proxmox"), None);
        assert_eq!(resolve_server(&on, "docker"), Some("docker".to_string()));
    }

    #[test]
    fn owner_resolves_a_bare_name_and_refuses_an_ambiguous_one() {
        let two = vec![conn("a", &["ping"]), conn("b", &["pong"])];
        assert_eq!(owner_of(&two, "ping"), Some("a"));
        assert_eq!(owner_of(&two, "pong"), Some("b"));
        assert_eq!(owner_of(&two, "missing"), None);
        // Both claim it: mcp.rs would qualify the name, so a bare one is unknown.
        let clash = vec![conn("a", &["ping"]), conn("b", &["ping"])];
        assert_eq!(owner_of(&clash, "ping"), None);
    }

    #[test]
    fn resolve_server_accepts_variants_but_not_a_different_name() {
        let list = vec![conn("my-docker", &["ping"])];
        assert_eq!(resolve_server(&list, "My Docker").as_deref(), Some("my-docker"));
        assert_eq!(resolve_server(&list, "my_docker").as_deref(), Some("my-docker"));
        assert_eq!(resolve_server(&list, "docker"), None);
        assert_eq!(resolve_server(&list, ""), None);
    }

}
