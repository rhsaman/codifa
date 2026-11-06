    use super::*;

    fn fixture(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codifa-repo-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// The exact layout of a real published bundle
    /// (`Jaace/claude-model-advisor`): a manifest in `.claude-plugin/`, ONE
    /// command with no frontmatter, a `hooks/hooks.json` whose handler lives in
    /// `hooks-handlers/` and is spelled `${CLAUDE_PLUGIN_ROOT}/…`, and no
    /// `SKILL.md` and no `mcp.json` anywhere. This is the bundle that used to
    /// fail with "nothing to install".
    #[test]
    fn a_commands_and_hooks_only_bundle_installs_whole() {
        let dir = fixture("claude-model-advisor");
        put(
            &dir,
            ".claude-plugin/plugin.json",
            r#"{"name":"model-advisor","version":"1.0.1","description":"Recommends the right model"}"#,
        );
        put(
            &dir,
            "commands/model-check.md",
            "Reassess the current session.\n\nArguments: $ARGUMENTS\n",
        );
        put(
            &dir,
            "hooks/hooks.json",
            r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-start.sh","timeout":5}]}]}}"#,
        );
        put(&dir, "hooks-handlers/session-start.sh", "#!/bin/sh\necho ready\n");

        let got = read_plugin(dir.to_str().unwrap(), "", "").unwrap();
        // The ROOT is the repo, not the hidden manifest folder: both parts sit
        // beside `.claude-plugin/`, so reading the manifest's folder found none.
        assert_eq!(got["name"], "model-advisor");
        let commands = got["commands"].as_array().unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["name"], "model-check");
        assert!(commands[0]["content"].as_str().unwrap().contains("$ARGUMENTS"));
        // The hook is declared AND its handler script travels with it: a
        // declaration pointing at a file the install never wrote could only
        // ever fail to start.
        let hooks = got["hooks"].as_array().unwrap();
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0]["event"], "SessionStart");
        let files = got["hook_files"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "hooks-handlers/session-start.sh");
    }

    #[test]
    fn an_index_lists_its_plugins_even_when_the_source_is_a_sub_folder() {
        // The browse list is the DISCOVERY half of install, and every row it
        // offers has to be a real install address: a row that cannot be
        // installed must not be listed as a clickable one.
        let dir = fixture("index");
        // The in-tree row points at a folder that really exists — a row whose
        // folder is missing must NOT be offered (it could never install).
        put(&dir, "bundles/in-tree/plugin.json", r#"{"name":"In Tree"}"#);
        put(
            &dir,
            "marketplace.json",
            r#"
{
  "name": "Demo Market",
  "description": "bundles we ship",
  "plugins": [
    {"name": "In Tree", "description": "lives here", "source": "./bundles/in-tree"},
    {"name": "Elsewhere", "source": {"url": "https://github.com/other/repo", "ref": "v2"}},
    {"name": "Gone", "source": "./bundles/not-there"},
    {"name": "  "},
    {"description": "no name, no address"}
  ]
}
"#,
        );
        let got = read_index(dir.to_str().unwrap(), "", "").unwrap();
        assert_eq!(got["name"], "Demo Market");
        // The two nameless rows and the missing folder are dropped, not listed.
        assert_eq!(got["count"], 2);
        let rows = got["plugins"].as_array().unwrap();
        let in_tree = rows.iter().find(|r| r["name"] == "In Tree").unwrap();
        // A sub-folder source points back into THIS repo, so the install address
        // is the marketplace itself plus that path.
        assert_eq!(in_tree["repo_path"], "bundles/in-tree");
        let elsewhere = rows.iter().find(|r| r["name"] == "Elsewhere").unwrap();
        assert_eq!(elsewhere["repo"], "https://github.com/other/repo");
        assert_eq!(elsewhere["repo_ref"], "v2");
    }

    #[test]
    fn claudes_index_file_name_is_found_too() {
        // Claude hides its index in `.claude-plugin/`, exactly like its
        // manifest — a marketplace written for Claude must open unchanged.
        let dir = fixture("index-claude");
        put(&dir, "plugins/ponytail/plugin.json", r#"{"name":"Ponytail"}"#);
        put(
            &dir,
            ".claude-plugin/marketplace.json",
            r#"{"name":"Official","plugins":[{"name":"Ponytail","source":"./plugins/ponytail"}]}"#,
        );
        let got = read_index(dir.to_str().unwrap(), "", "").unwrap();
        assert_eq!(got["name"], "Official");
        assert_eq!(got["plugins"][0]["name"], "Ponytail");
    }

    #[test]
    fn a_root_source_row_points_at_the_marketplace_itself() {
        // anthropics/skills advertises ONE bundle: `"source": "./"`. That is
        // the marketplace's own root — a real install address, not a row to
        // drop. Dropping it left the Skills tab permanently empty.
        let dir = fixture("index-root");
        put(&dir, "skills/xlsx/SKILL.md", "---\nname: xlsx\n---\nbody");
        put(
            &dir,
            ".claude-plugin/marketplace.json",
            r#"{"name":"Skills","plugins":[{"name":"document-skills","source":"./"}]}"#,
        );
        let got = read_index(dir.to_str().unwrap(), "", "").unwrap();
        assert_eq!(got["count"], 1);
        let row = &got["plugins"][0];
        let (spec, sub, _) = Repo::open(dir.to_str().unwrap(), "", "")
            .unwrap()
            .install_args();
        assert_eq!(row["repo"], spec);
        assert_eq!(row["repo_path"], sub);
    }

    #[test]
    fn a_browsed_index_is_served_from_the_disk_copy() {
        // Opening Settings must not spend GitHub's 60-an-hour budget on every
        // visit: the tab opens the catalogue on its own, so a cold read per
        // visit drained it and then showed an EMPTY tab. The copy also has to
        // keep working after the source is gone, otherwise "offline" and
        // "rate limited" still mean a blank catalogue.
        let dir = fixture("index-cache-src");
        put(
            &dir,
            "marketplace.json",
            r#"{"name":"Cached","plugins":[{"name":"A","source":{"url":"https://github.com/o/r"}}]}"#,
        );
        let cache = fixture("index-cache-store");
        let first = read_index_cached(&cache, dir.to_str().unwrap(), "", "", false).unwrap();
        assert_eq!(first["name"], "Cached");

        // The source disappears: a fresh copy must still answer, and it must be
        // the SAVED bytes, which proves the read never went out again.
        fs::remove_dir_all(&dir).unwrap();
        // Age the copy past the TTL so the stale path is the one under test
        // (a still-fresh copy returns before ever touching the source).
        let cached_file = fs::read_dir(&cache)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|x| x == "json"))
            .unwrap();
        let old = std::time::SystemTime::now() - INDEX_TTL - std::time::Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(&cached_file)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let again = read_index_cached(&cache, dir.to_str().unwrap(), "", "", false).unwrap();
        assert_eq!(again["name"], "Cached");
        // Marked stale so the tab can say the list may be out of date instead of
        // presenting an old catalogue as the current one.
        assert_eq!(again["stale"], true);

        // `refresh` bypasses the copy, so the explicit button reports the real
        // state of the remote instead of a stale success.
        assert!(read_index_cached(&cache, dir.to_str().unwrap(), "", "", true).is_err());
    }

    #[test]
    fn a_folder_without_an_index_says_so() {
        // Browsing names the exact file it wanted instead of returning an empty
        // list that reads like an empty marketplace.
        let dir = fixture("index-missing");
        put(&dir, "README.md", "nothing here");
        let err = read_index(dir.to_str().unwrap(), "", "").unwrap_err();
        assert!(err.contains("marketplace.json"), "{err}");
    }

    #[test]
    fn parse_accepts_every_shape_a_user_types() {
        let plain = parse("DietrichGebert/ponytail").unwrap();
        assert_eq!(plain.owner, "DietrichGebert");
        assert_eq!(plain.name, "ponytail");
        assert!(plain.sub.is_empty());

        let url = parse("https://github.com/owner/repo.git").unwrap();
        assert_eq!(url.owner, "owner");
        assert_eq!(url.name, "repo");

        let tree = parse("https://github.com/owner/repo/tree/dev/skills/x").unwrap();
        assert_eq!(tree.git_ref, "dev");
        assert_eq!(tree.sub, "skills/x");

        let ssh = parse("git@github.com:owner/repo.git").unwrap();
        assert_eq!(ssh.name, "repo");

        let local = fixture("parse-local");
        assert!(parse(local.to_str().unwrap()).unwrap().local.is_some());

        assert!(parse("").is_err());
        assert!(parse("https://gitlab.com/owner/repo").is_err());
    }

    #[test]
    fn open_filters_to_the_requested_sub_folder() {
        let dir = fixture("sub");
        put(&dir, "one/skills/a/SKILL.md", "---\nname: a\n---\nbody");
        put(&dir, "one/README.md", "readme");
        put(&dir, "two/skills/b/SKILL.md", "---\nname: b\n---\nbody");
        let repo = Repo::open(dir.to_str().unwrap(), "one", "").unwrap();
        assert_eq!(repo.files(), ["README.md", "skills/a/SKILL.md"]);
    }

    #[test]
    fn claude_layout_roots_at_the_repo_not_the_hidden_manifest() {
        let dir = fixture("claude");
        put(
            &dir,
            ".claude-plugin/plugin.json",
            r#"{"name":"Demo Bundle","description":"demo bundle","version":"0.2.0"}"#,
        );
        put(
            &dir,
            "skills/alpha/SKILL.md",
            "---\nname: alpha\ndescription: >\n  Reviews a change\n  for logic errors.\n---\n\n# alpha\n\nDo it.",
        );
        put(&dir, "skills/alpha/ref/notes.txt", "notes");
        put(&dir, "skills/beta/SKILL.md", "---\nname: beta\n---\n\n# beta\n\nBody.");
        put(
            &dir,
            ".mcp.json",
            r#"{"mcpServers":{"demo":{"command":"npx","args":["demo"]}}}"#,
        );
        let got = read_plugin(dir.to_str().unwrap(), "", "").unwrap();
        assert_eq!(got["name"], "Demo Bundle");
        assert_eq!(got["version"], "0.2.0");
        let skills = got["skills"].as_array().unwrap();
        assert_eq!(skills.len(), 2);
        let alpha = skills
            .iter()
            .find(|s| s["name"] == "alpha")
            .expect("alpha skill");
        // The block scalar is folded onto one line instead of the literal ">".
        assert_eq!(alpha["description"], "Reviews a change for logic errors.");
        assert_eq!(alpha["extra_files"]["ref__notes.txt"], "notes");
        assert_eq!(got["mcp"]["demo"]["command"], "npx");
    }

    #[test]
    fn manifest_beside_the_skills_is_also_a_root() {
        let dir = fixture("ponytail");
        put(&dir, "skills/plugin.json", r#"{"name":"Ponytail"}"#);
        put(&dir, "skills/review/SKILL.md", "---\nname: review\n---\nBody.");
        put(&dir, "README.md", "not a skill");
        let got = read_plugin(dir.to_str().unwrap(), "", "").unwrap();
        assert_eq!(got["name"], "Ponytail");
        assert_eq!(got["skills"].as_array().unwrap().len(), 1);
        assert_eq!(got["manifest"], "skills/plugin.json");
    }

    #[test]
    fn one_bundle_published_to_four_hosts_is_one_plugin() {
        // The real `Upload-Post/upload-post-plugin` layout: ONE bundle shipped to
        // Claude, Codex, Cursor and Grok, so each host's dot-folder carries its
        // own manifest at the SAME depth. All four root to the repo, so this is
        // one install — it used to be refused as "more than one plugin" and the
        // user was told to pass a `repo_path` that does not exist.
        let dir = fixture("multi-host");
        put(
            &dir,
            ".claude-plugin/plugin.json",
            r#"{"name":"upload-post","version":"0.4.0","description":"social media scheduler"}"#,
        );
        put(&dir, ".codex-plugin/plugin.json", r#"{"name":"up-post"}"#);
        put(&dir, ".cursor-plugin/plugin.json", r#"{"name":"up-post"}"#);
        put(&dir, ".grok-plugin/plugin.json", r#"{"name":"up-post"}"#);
        put(&dir, ".mcp.json", r#"{"mcpServers":{"up":{"url":"https://x.test/mcp"}}}"#);
        put(
            &dir,
            "skills/publish/SKILL.md",
            "---\nname: publish\ndescription: Post a video.\n---\n\n# publish\n\nGo.",
        );
        put(
            &dir,
            "agents/post-debugger.md",
            "---\nname: post-debugger\ndescription: Debugs a failed post.\ntools: read, grep\n---\nFind the reason.",
        );
        let got = read_plugin(dir.to_str().unwrap(), "", "").unwrap();
        // The repo roots at itself, and the Claude manifest is the one recorded:
        // it is the shape that carries every part.
        assert_eq!(got["manifest"], ".claude-plugin/plugin.json");
        assert_eq!(got["name"], "upload-post");
        assert_eq!(got["version"], "0.4.0");
        assert_eq!(got["skills"].as_array().unwrap().len(), 1);
        assert_eq!(got["agents"].as_array().unwrap().len(), 1);
        assert_eq!(got["mcp"]["up"]["url"], "https://x.test/mcp");
    }

    #[test]
    fn two_plugins_in_two_folders_are_still_refused() {
        // The check still has to fire when the manifests root at DIFFERENT
        // folders: otherwise folding the host dot-folders would have silently
        // made every multi-plugin repo install the wrong one.
        let dir = fixture("two-plugins");
        put(&dir, "alpha/.claude-plugin/plugin.json", r#"{"name":"alpha"}"#);
        put(
            &dir,
            "alpha/skills/a/SKILL.md",
            "---\nname: a\n---\nBody.",
        );
        put(&dir, "beta/.claude-plugin/plugin.json", r#"{"name":"beta"}"#);
        put(
            &dir,
            "beta/skills/b/SKILL.md",
            "---\nname: b\n---\nBody.",
        );
        let err = read_plugin(dir.to_str().unwrap(), "", "").unwrap_err();
        assert!(err.contains("more than one plugin"), "{err}");
        // Listed as FOLDERS, because that is what `repo_path` takes.
        assert!(err.contains("  alpha"), "{err}");
        assert!(err.contains("  beta"), "{err}");
        // And each one alone installs.
        let alpha = read_plugin(dir.to_str().unwrap(), "alpha", "").unwrap();
        assert_eq!(alpha["name"], "alpha");
    }

    #[test]
    fn zcode_layout_roots_at_the_repo_not_the_hidden_manifest() {
        // The ZCode plugin cache (`~/.zcode/cli/plugins/cache/<market>/<name>/<version>/`)
        // parks its manifest in `.zcode-plugin/`. Reading that root as the bundle
        // itself found no skills under it and refused every install; the root is
        // the version folder, exactly like Claude's `.claude-plugin/`. The shape
        // below mirrors a real cached plugin: `package.json` and `agents/` sit
        // beside `skills/`, and neither may leak in as a bundle part.
        let dir = fixture("zcode");
        put(
            &dir,
            ".zcode-plugin/plugin.json",
            r#"{"name":"documents","version":"0.2.1","description":"DOCX document production skills"}"#,
        );
        put(&dir, "package.json", r#"{"name":"documents"}"#);
        put(
            &dir,
            "skills/docx/SKILL.md",
            "---\nname: docx\ndescription: DOCX production.\n---\n\n# docx\n\nMake it.",
        );
        put(&dir, "skills/docx/scripts/make.py", "print('hi')");
        put(
            &dir,
            "skills/docx-viewer/SKILL.md",
            "---\nname: docx-viewer\n---\nViewer body.",
        );
        put(&dir, "agents/visual-judge.md", "judge");
        let got = read_plugin(dir.to_str().unwrap(), "", "").unwrap();
        assert_eq!(got["name"], "documents");
        assert_eq!(got["version"], "0.2.1");
        let skills = got["skills"].as_array().unwrap();
        assert_eq!(skills.len(), 2);
        let docx = skills
            .iter()
            .find(|s| s["name"] == "docx")
            .expect("docx skill");
        assert_eq!(docx["extra_files"]["scripts__make.py"], "print('hi')");
        // The ZCode-host MCP server lives inside the manifest's `mcpServers`, not
        // in a `.mcp.json` file, so nothing connector-shaped installs from it.
        assert!(got["mcp"].as_object().is_none_or(|m| m.is_empty()));
    }

    #[test]
    fn skill_pick_uses_the_hint_and_refuses_to_guess() {
        let dir = fixture("pick");
        put(&dir, "skills/one/SKILL.md", "---\nname: One Skill\n---\nBody one.");
        put(&dir, "skills/two/SKILL.md", "---\nname: Two Skill\n---\nBody two.");
        let err = read_skill(dir.to_str().unwrap(), "", "", "").unwrap_err();
        assert!(err.contains("skills/one/SKILL.md"), "{err}");
        let picked = read_skill(dir.to_str().unwrap(), "", "", "two").unwrap();
        assert_eq!(picked["name"], "Two Skill");
        assert_eq!(picked["content"], "Body two.");

        let single = fixture("pick-single");
        put(&single, "only/SKILL.md", "---\nname: Solo\n---\nBody.");
        assert_eq!(
            read_skill(single.to_str().unwrap(), "", "", "").unwrap()["name"],
            "Solo"
        );
    }

    #[test]
    fn a_bundle_without_a_skill_is_an_explicit_error() {
        let dir = fixture("empty");
        put(&dir, "README.md", "nothing here");
        let err = read_plugin(dir.to_str().unwrap(), "", "").unwrap_err();
        // The message names every installable shape, so a bundle that carries
        // none of them says which one it looked for.
        assert!(err.contains("nothing to install from"), "{err}");
        assert!(err.contains("skills/*/SKILL.md"), "{err}");
    }
