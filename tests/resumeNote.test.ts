import { strict as assert } from "node:assert";
import { buildResumeNote } from "../src/lib/resumeNote";

const pending = [
  { content: "step one", status: "pending" },
  { content: "step two", status: "pending" },
];

// 1) Plan mode must NOT get the resume note: its checklist IS the draft plan
// and "PRESERVE, do not create a new one" contradicted the revise contract,
// so the planner never emitted a revised plan_card and todos never updated.
{
  const note = buildResumeNote([{ plan: pending, mode: "plan" }], "plan");
  assert.equal(note, "", "plan mode must not receive the resume note");
  console.log("PASS: plan mode gets no resume note");
}

// 2) Coder mode keeps the old behavior: unfinished same-mode checklist.
{
  const note = buildResumeNote([{ plan: pending, mode: "coder" }], "coder");
  assert.ok(
    note.includes("PRESERVE this exact checklist"),
    "coder mode must keep the resume note",
  );
  console.log("PASS: coder mode keeps the resume note");
}

// 3) Fully completed checklist: no note in any mode.
{
  const done = [{ content: "step one", status: "completed" }];
  assert.equal(buildResumeNote([{ plan: done, mode: "coder" }], "coder"), "");
  assert.equal(buildResumeNote([{ plan: done, mode: "plan" }], "plan"), "");
  console.log("PASS: completed checklist produces no note");
}

// 4) No checklist at all: no note.
{
  assert.equal(buildResumeNote([{ mode: "coder" }], "coder"), "");
  console.log("PASS: no checklist produces no note");
}

console.log("ALL RESUME NOTE TESTS PASSED");
