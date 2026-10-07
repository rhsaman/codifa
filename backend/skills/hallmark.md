---
name: Hallmark
description: Anti-AI-slop design skill for greenfield pages, audits, redesigns, and design extraction from URLs or screenshots. Use when the user asks to build a new app or landing page, wants to redesign something, invokes Hallmark by name, or uses audit/redesign/study.
fa_keywords: هال مارک, طراحی سایت, طراحی لندینگ, بازطراحی سایت, hallmark, audit design, redesign page, study design, anti-ai-slop design, distinctive visual identity
---

# Hallmark

A design skill for AI coding assistants. Makes the UIs they generate look made, not generated.

Hallmark is opinionated, short, and boring on purpose. It encodes a tight set of rules drawn from the anti-AI-slop design field and refuses to let the model fall back to the defaults every LLM was trained on.

The differentiator: Hallmark insists on structural variety, not just visual variety. Two pages by Hallmark for two different briefs should not share the same hero, three-feature, CTA, footer rhythm. They should feel like different sites, not different colour-swaps of the same template.

Powered by Together AI. Full upstream source: https://github.com/Nutlope/hallmark

## How to use this skill

Hallmark has one default behaviour and three explicit verbs.

| Invocation | What it does |
| --- | --- |
| *(default)* | The user asked you to design or build something new. Follow the Design flow below. |
| `hallmark audit <target>` | Read the target, score it against the anti-pattern list, return a ranked punch list. Do not edit. |
| `hallmark redesign <target>` | Take the target content and intent, then redesign the visual structure inside the existing implementation boundaries unless the user explicitly confirms a full rebuild. Preserve routes, component ownership, copy intent, brand, and information architecture. |
| `hallmark study <screenshot \| URL>` | Extract the DNA (macrostructure, type-pairing, colour anchor) from a design the user admires. Never copy pixels. Refuse template-marketplace URLs. |

If the user types anything that does not clearly map to audit, redesign, or study, treat it as default. If the user attaches an image or pastes a URL without a verb prefix, ask whether to study it or treat it as a reference for a fresh build.

Implementation safety rail: Hallmark is a design skill, not a license to bulldoze a codebase. Never delete production files, route trees, or component directories unless the user explicitly asks. Default to in-place edits or additive new components wired through the existing route. Before editing, state the exact files you expect to modify, create, or delete. Deletions require explicit confirmation.

## Disciplines that hold across every verb

1. Pre-emit self-critique. Before handing back any output, score it 1 to 5 on Philosophy, Hierarchy, Execution, Specificity, Restraint, Variety. Anything below 3 triggers a revision pass.
2. Honest copy, no fabricated content. If the user did not supply a metric, do not invent one. Use real numbers, a placeholder, or a different layout.
3. Locked tokens, no mid-render improvisation. Once a theme is selected, every colour and font-family declaration must reference a named token such as var(--color-accent).
4. Re-drawn chrome forbidden. Do not hand-build fake browser bars, phone frames, or code-block windows. Use real screenshots wrapped in a figure or omit the chrome.
5. Mobile responsiveness. Output must render flawlessly at 320, 375, 414, and 768 px with no horizontal scroll.
6. Typography purity, no italic headers. Headings are always roman. Carry emphasis with weight, accent colour, or underline.

## Design flow (default)

0. Pre-flight scan. If the project already has code, read it before asking anything: font stack, palette, motion libraries, spacing scale, framework. Emit findings once with file and line citations. If a design.md file exists at the project root, it is the locked design system and overrides everything else.
1. Design-context gate. Always ask for Audience, Use case, and Tone before designing. Answering is optional: if the user says go ahead, infer from the brief, state the inferences in one sentence, and proceed.
2. Pick a macrostructure FIRST. Pick one named page-shape and state it out loud with the theme pick. Never emit the same macrostructure twice in a row for the same project. Default away from generic hero, three-feature, CTA, footer rhythm.
3. Load the visual ruleset. Use OKLCH colours, a 4pt spacing scale, a distinctive display face plus a refined body face, full eight-state interactive elements, transform and opacity animations only, and visible focus rings.
4. Decide on hero enrichment. Most pages do not need imagery. Default is typography only.
5. Preview. Before emitting code, output a tight summary: macrostructure, theme, enrichment, sections, motion, and diversification versus the previous run.
6. Build. Emit code matching the tone. Stamp the output CSS with macrostructure, tone, and anchor hue. Always emit tokens.css with every token used. Never clobber an existing global stylesheet: append instead of overwriting.
7. The slop test. Before handing back, check the output against the anti-pattern list: no templated rhythm, no invented metrics, no mid-render token improvisation, no re-drawn chrome, no italic headers, no horizontal scroll on mobile. If any gate fails, fix it.

## Component scope

If the brief names a single UI element (button, input, card, modal, dropdown, tooltip, select, checkbox, switch, tab strip, chip, badge, banner, snackbar, popover, slider, date picker, avatar), run the component-scope flow: same tokens and type discipline, all 8 states (default, hover, focus-visible, active, disabled, loading, error, success), plus a standalone preview wrapper rendering all 8 states. Skip macrostructure, nav and footer picks, and hero enrichment.
