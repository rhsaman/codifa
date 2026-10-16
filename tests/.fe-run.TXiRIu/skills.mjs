// src/lib/skills.ts
var SLUG_RE = /(^|\s)@([\w-]+)/g;
function buildIndex(skills) {
  const idx = /* @__PURE__ */ new Map();
  for (const s of skills) {
    if (s.slug) idx.set(s.slug.toLowerCase(), s);
    if (s.name) idx.set(s.name.toLowerCase(), s);
  }
  return idx;
}
function extractMentionSkills(text, skills) {
  if (!skills.length) return { skills: [], cleaned: text };
  const idx = buildIndex(skills);
  const found = /* @__PURE__ */ new Set();
  let out = "";
  let last = 0;
  let matchedAny = false;
  SLUG_RE.lastIndex = 0;
  let m;
  while ((m = SLUG_RE.exec(text)) !== null) {
    const token = m[2];
    const skill = idx.get(token.toLowerCase());
    if (!skill) continue;
    matchedAny = true;
    found.add(skill.name);
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
  }
  if (last > 0) out += text.slice(last);
  if (!matchedAny) out = text;
  const spaced = skills.filter((s) => /\s/.test(s.name)).sort((a, b) => b.name.length - a.name.length);
  if (spaced.length) {
    let out2 = "";
    let last2 = 0;
    let i = 0;
    while (i < out.length) {
      const at = out.indexOf("@", i);
      if (at === -1) {
        out2 += out.slice(i);
        break;
      }
      out2 += out.slice(i, at);
      const rest = out.slice(at + 1);
      let best = null;
      for (const s of spaced) {
        if (rest.toLowerCase().startsWith(s.name.toLowerCase())) {
          best = s;
          break;
        }
      }
      if (best) {
        matchedAny = true;
        found.add(best.name);
        i = at + 1 + best.name.length;
      } else {
        out2 += "@";
        i = at + 1;
      }
    }
    out = out2;
  }
  return { skills: Array.from(found), cleaned: out };
}

// tests/skills.test.ts
var failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    console.error(`  \u274C ${name}`, extra ?? "");
  }
}
var SKILLS = [
  { name: "Anthropic Frontend Design", slug: "anthropic-frontend-design" },
  { name: "learning-explainer", slug: "learning-explainer" },
  { name: "data-analysis", slug: "data-analysis" }
];
console.log("1) \u062A\u0648\u06A9\u0646 slug (\u0641\u0631\u0645\u062A \u0628\u06CC\u200C\u0627\u0628\u0647\u0627\u0645 \u062E\u0637\u200C\u062A\u06CC\u0631\u0647):");
{
  const { skills, cleaned } = extractMentionSkills(
    "@anthropic-frontend-design \u06CC\u0647 \u062F\u0627\u0634\u0628\u0648\u0631\u062F \u0633\u0627\u062F\u0647 \u0637\u0631\u0627\u062D\u06CC \u06A9\u0646",
    SKILLS
  );
  check("\u0646\u0627\u0645 \u0627\u0633\u06A9\u06CC\u0644 \u0627\u0633\u062A\u062E\u0631\u0627\u062C \u0634\u062F", skills.length === 1 && skills[0] === "Anthropic Frontend Design", skills);
  check("\u0645\u062A\u0646 \u067E\u0627\u06A9 \u0634\u062F (\u0628\u062F\u0648\u0646 @)", !cleaned.includes("@"), cleaned);
  check("\u0628\u0642\u06CC\u0647\u0654 \u062C\u0645\u0644\u0647 \u062D\u0641\u0638 \u0634\u062F", cleaned.includes("\u06CC\u0647 \u062F\u0627\u0634\u0628\u0648\u0631\u062F \u0633\u0627\u062F\u0647 \u0637\u0631\u0627\u062D\u06CC \u06A9\u0646"), cleaned);
}
{
  const { skills } = extractMentionSkills("@learning-explainer \u062A\u0641\u0627\u0648\u062A async \u0686\u06CC\u0633\u062A\u061F", SKILLS);
  check("\u0627\u0633\u06A9\u06CC\u0644 \u062A\u06A9\u200C\u06A9\u0644\u0645\u0647\u200C\u0627\u06CC \u0628\u0627 slug \u06A9\u0627\u0631 \u0645\u06CC\u200C\u06A9\u0646\u062F", skills[0] === "learning-explainer", skills);
}
console.log("2) \u0633\u0627\u0632\u06AF\u0627\u0631\u06CC \u0628\u0627 \u0646\u0627\u0645 \u0646\u0645\u0627\u06CC\u0634\u06CC \u0628\u0627 \u0641\u0627\u0635\u0644\u0647 (fallback):");
{
  const { skills, cleaned } = extractMentionSkills(
    "@Anthropic Frontend Design \u06CC\u0647 \u062F\u0627\u0634\u0628\u0648\u0631\u062F \u0633\u0627\u062F\u0647 \u0637\u0631\u0627\u062D\u06CC \u06A9\u0646",
    SKILLS
  );
  check("\u0646\u0627\u0645 \u0686\u0646\u062F\u06A9\u0644\u0645\u0647\u200C\u0627\u06CC \u062A\u0634\u062E\u06CC\u0635 \u062F\u0627\u062F\u0647 \u0634\u062F", skills.length === 1 && skills[0] === "Anthropic Frontend Design", skills);
  check("\u0645\u062A\u0646 \u067E\u0627\u06A9 \u0634\u062F", !cleaned.includes("@"), cleaned);
}
console.log("3) \u0686\u0646\u062F \u0645\u0646\u0634\u0646 \u062F\u0631 \u06CC\u06A9 \u067E\u06CC\u0627\u0645:");
{
  const { skills } = extractMentionSkills(
    "@learning-explainer \u0648 @data-analysis \u0631\u0648 \u0645\u0642\u0627\u06CC\u0633\u0647 \u06A9\u0646",
    SKILLS
  );
  check("\u0647\u0631 \u062F\u0648 \u0627\u0633\u06A9\u06CC\u0644 \u067E\u06CC\u062F\u0627 \u0634\u062F\u0646\u062F", skills.length === 2, skills);
  check("\u0646\u0627\u0645\u200C\u0647\u0627 \u062F\u0631\u0633\u062A \u0647\u0633\u062A\u0646\u062F", skills.includes("learning-explainer") && skills.includes("data-analysis"), skills);
}
console.log("4) \u0645\u0646\u0634\u0646 \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0646\u0627\u062F\u06CC\u062F\u0647 \u06AF\u0631\u0641\u062A\u0647 \u0645\u06CC\u200C\u0634\u0648\u062F:");
{
  const { skills, cleaned } = extractMentionSkills("@unknown-skill \u0627\u06CC\u0646 \u0631\u0648 \u062A\u0633\u062A \u06A9\u0646", SKILLS);
  check("\u0627\u0633\u06A9\u06CC\u0644 \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A\u062E\u0631\u0627\u062C \u0646\u0634\u062F", skills.length === 0, skills);
  check("\u0645\u062A\u0646 \u062F\u0633\u062A\u200C\u0646\u062E\u0648\u0631\u062F\u0647 \u0645\u0627\u0646\u062F", cleaned === "@unknown-skill \u0627\u06CC\u0646 \u0631\u0648 \u062A\u0633\u062A \u06A9\u0646", cleaned);
}
console.log("5) \u0628\u062F\u0648\u0646 \u0627\u0633\u06A9\u06CC\u0644 \u062F\u0631 \u0644\u06CC\u0633\u062A:");
{
  const { skills, cleaned } = extractMentionSkills("@anthropic-frontend-design \u0633\u0644\u0627\u0645", []);
  check("\u062E\u0631\u0648\u062C\u06CC \u062E\u0627\u0644\u06CC \u0627\u0633\u062A", skills.length === 0 && cleaned === "@anthropic-frontend-design \u0633\u0644\u0627\u0645", { skills, cleaned });
}
console.log("6) \u062D\u0633\u0627\u0633\u06CC\u062A \u0628\u0647 \u062D\u0631\u0648\u0641 \u06A9\u0648\u0686\u06A9/\u0628\u0632\u0631\u06AF \u0646\u062F\u0627\u0631\u062F:");
{
  const { skills } = extractMentionSkills("@ANTHROPIC-FRONTEND-DESIGN x", SKILLS);
  check("slug \u0628\u0627 \u062D\u0631\u0648\u0641 \u0628\u0632\u0631\u06AF \u0647\u0645 \u06A9\u0627\u0631 \u0645\u06CC\u200C\u06A9\u0646\u062F", skills[0] === "Anthropic Frontend Design", skills);
}
console.log("7) \u0645\u0646\u0634\u0646 \u062A\u06A9\u0631\u0627\u0631\u06CC \u0641\u0642\u0637 \u06CC\u06A9 \u0627\u0646\u062A\u062E\u0627\u0628 \u0645\u06CC\u200C\u0633\u0627\u0632\u062F:");
{
  const { skills } = extractMentionSkills(
    "@data-analysis \u0648 \u0628\u0639\u062F \u062F\u0648\u0628\u0627\u0631\u0647 @data-analysis",
    SKILLS
  );
  check("\u0627\u0633\u06A9\u06CC\u0644 \u062A\u06A9\u0631\u0627\u0631\u06CC \u06CC\u06A9\u200C\u0628\u0627\u0631 \u0627\u0646\u062A\u062E\u0627\u0628 \u0634\u062F", skills.length === 1 && skills[0] === "data-analysis", skills);
}
console.log("8) \u0646\u0627\u0645 \u0627\u0633\u06A9\u06CC\u0644 \u0628\u062F\u0648\u0646 @ \u0627\u0646\u062A\u062E\u0627\u0628 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F:");
{
  const { skills, cleaned } = extractMentionSkills(
    "data-analysis \u0631\u0648 \u0628\u0631\u0627\u0645 \u062A\u0648\u0636\u06CC\u062D \u0628\u062F\u0647",
    SKILLS
  );
  check("\u0628\u062F\u0648\u0646 @ \u0627\u0646\u062A\u062E\u0627\u0628\u06CC \u0633\u0627\u062E\u062A\u0647 \u0646\u0634\u062F", skills.length === 0, skills);
  check("\u0645\u062A\u0646 \u062F\u0633\u062A\u200C\u0646\u062E\u0648\u0631\u062F\u0647 \u0645\u0627\u0646\u062F", cleaned === "data-analysis \u0631\u0648 \u0628\u0631\u0627\u0645 \u062A\u0648\u0636\u06CC\u062D \u0628\u062F\u0647", cleaned);
}
if (failed > 0) {
  console.error(`
${failed} \u062A\u0633\u062A \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F \u274C`);
  process.exit(1);
}
console.log("\n\u0647\u0645\u0647 \u062A\u0633\u062A\u0647\u0627 \u067E\u0627\u0633 \u0634\u062F\u0646\u062F \u2705");
