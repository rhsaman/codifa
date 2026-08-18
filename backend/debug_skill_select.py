"""Repro: why does 'پروژه رو پوش کن تو گیت' pick design skills?

Runs the REAL skill selection pipeline against the user's real data root
(~/.codifa) and prints every layer: keyword tokens, keyword-tier matches,
semantic scores, and the final picks.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (_HERE, os.path.dirname(_HERE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Use the REAL user data root (skills live there).
os.environ.pop("CODER_DATA_DIR", None)

import agents
from tools import open_skill_store

PROMPTS = [
    "پروژه رو پوش کن تو گیت",
    "push the project to git",
    "یه کد پایتون بنویس",
    "تست بنویس برای پروژه",
    "طراحی UI برای داشبورد",
]


def main() -> None:
    skills = agents._load_skills("")
    print(f"=== {len(skills)} skills installed ===")
    for s in skills:
        print(f"  - {s['name']!r} | desc: {s['description'][:80]!r}")

    store = open_skill_store()
    agents._sync_skills_to_store(store, skills)

    for prompt in PROMPTS:
        print(f"\n{'=' * 70}\nPROMPT: {prompt!r}")
        tokens = agents._fts_keywords(prompt, max_terms=8)
        print(f"  _fts_keywords -> {tokens}")

        kw = agents._skill_keyword_matches(prompt, skills)
        print(f"  keyword tier matches ({len(kw)}):")
        for _w, s in kw:
            print(f"    - {s['name']!r}")

        # semantic scores for every skill
        hits = store.search(prompt, kind=agents.KIND_SKILL, top_k=max(len(skills) * 4, 8), min_score=0.0)
        by_path = {s["path"]: s for s in skills}
        sem = {}
        for hit in hits:
            key = hit.get("key")
            if key and key not in sem and key in by_path:
                sem[key] = float(hit.get("score", 0.0))
        print("  semantic scores (top 8):")
        for key, score in sorted(sem.items(), key=lambda x: x[1], reverse=True)[:8]:
            print(f"    {score:.4f}  {by_path[key]['name']!r}")

        picked = agents._auto_select_skills(store, skills, prompt)
        print(f"  FINAL PICK: {[s['name'] for s in picked]}")


if __name__ == "__main__":
    main()