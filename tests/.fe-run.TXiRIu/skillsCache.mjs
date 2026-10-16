// src/lib/skills.ts
var skillsCache = null;
var skillsFetcher = async () => [];
function setSkillsFetcher(fn) {
  skillsFetcher = fn;
}
function getSkillsList() {
  return skillsCache ?? [];
}
async function ensureSkillsList() {
  if (skillsCache === null || skillsCache.length === 0) {
    skillsCache = await skillsFetcher();
  }
  return skillsCache;
}
function invalidateSkillsList() {
  skillsCache = null;
  void ensureSkillsList();
}
function resetSkillsCacheForTest() {
  skillsCache = null;
}
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

// tests/skillsCache.test.ts
var failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    console.error(`  \u274C ${name}`, extra ?? "");
  }
}
var OLD = [
  { name: "learning-explainer", slug: "learning-explainer" }
];
var NEW = [
  ...OLD,
  { name: "Anthropic Frontend Design", slug: "anthropic-frontend-design" }
];
var backendList = OLD;
setSkillsFetcher(async () => backendList);
console.log("1) \u06A9\u0634 \u062F\u0631 \u0627\u0628\u062A\u062F\u0627 \u062E\u0627\u0644\u06CC \u0627\u0633\u062A:");
{
  resetSkillsCacheForTest();
  check("getSkillsList \u062E\u0627\u0644\u06CC \u0628\u0631\u0645\u06CC\u200C\u06AF\u0631\u062F\u0627\u0646\u062F", getSkillsList().length === 0, getSkillsList());
}
console.log("2) \u0628\u0627\u0631\u06AF\u0630\u0627\u0631\u06CC \u0627\u0648\u0644\u06CC\u0647 \u0627\u0632 \u0628\u06A9\u200C\u0627\u0646\u062F:");
{
  resetSkillsCacheForTest();
  backendList = OLD;
  const list = await ensureSkillsList();
  check("\u0644\u06CC\u0633\u062A \u0642\u062F\u06CC\u0645\u06CC \u0628\u0627\u0631\u06AF\u0630\u0627\u0631\u06CC \u0634\u062F", list.length === 1 && list[0].slug === "learning-explainer", list);
  check("\u0627\u0633\u06A9\u06CC\u0644 \u062C\u062F\u06CC\u062F \u0647\u0646\u0648\u0632 \u062F\u06CC\u062F\u0647 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F", !getSkillsList().some((s) => s.slug === "anthropic-frontend-design"), getSkillsList());
}
console.log("3) \u0633\u0646\u0627\u0631\u06CC\u0648\u06CC \u0630\u062E\u06CC\u0631\u0647\u0654 \u0627\u0633\u06A9\u06CC\u0644 \u062C\u062F\u06CC\u062F (\u0631\u0641\u0631\u0634 \u06A9\u0634):");
{
  backendList = NEW;
  invalidateSkillsList();
  await new Promise((r) => setTimeout(r, 10));
  check("\u0628\u0639\u062F \u0627\u0632 invalidate\u060C \u0627\u0633\u06A9\u06CC\u0644 \u062C\u062F\u06CC\u062F \u062F\u0631 \u06A9\u0634 \u0647\u0633\u062A", getSkillsList().some((s) => s.slug === "anthropic-frontend-design"), getSkillsList());
  const { skills } = extractMentionSkills("@anthropic-frontend-design \u0637\u0631\u0627\u062D\u06CC \u06A9\u0646", getSkillsList());
  check("\u0645\u0646\u0634\u0646 \u0627\u0633\u06A9\u06CC\u0644 \u062A\u0627\u0632\u0647\u200C\u0630\u062E\u06CC\u0631\u0647\u200C\u0634\u062F\u0647 \u06A9\u0627\u0631 \u0645\u06CC\u200C\u06A9\u0646\u062F", skills.length === 1 && skills[0] === "Anthropic Frontend Design", skills);
}
console.log("4) \u062D\u0630\u0641 \u0627\u0633\u06A9\u06CC\u0644 (\u0631\u0641\u0631\u0634 \u0644\u06CC\u0633\u062A):");
{
  backendList = OLD;
  invalidateSkillsList();
  await new Promise((r) => setTimeout(r, 10));
  check("\u0627\u0633\u06A9\u06CC\u0644 \u062D\u0630\u0641\u200C\u0634\u062F\u0647 \u062F\u06CC\u06AF\u0631 \u062F\u0631 \u06A9\u0634 \u0646\u06CC\u0633\u062A", !getSkillsList().some((s) => s.slug === "anthropic-frontend-design"), getSkillsList());
}
if (failed > 0) {
  console.error(`
${failed} \u062A\u0633\u062A \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F \u274C`);
  process.exit(1);
}
console.log("\n\u0647\u0645\u0647 \u062A\u0633\u062A\u0647\u0627\u06CC \u06A9\u0634 \u067E\u0627\u0633 \u0634\u062F\u0646\u062F \u2705");
