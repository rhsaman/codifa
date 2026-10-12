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

// 2) Build mode keeps the old behavior: unfinished same-mode checklist.
{
  const note = buildResumeNote([{ plan: pending, mode: "build" }], "build");
  assert.ok(
    note.includes("PRESERVE this exact checklist"),
    "build mode must keep the resume note",
  );
  console.log("PASS: build mode keeps the resume note");
}

// 3) Fully completed checklist: no note in any mode.
{
  const done = [{ content: "step one", status: "completed" }];
  assert.equal(buildResumeNote([{ plan: done, mode: "build" }], "build"), "");
  assert.equal(buildResumeNote([{ plan: done, mode: "plan" }], "plan"), "");
  console.log("PASS: completed checklist produces no note");
}

// 4) No checklist at all: no note.
{
  assert.equal(buildResumeNote([{ mode: "build" }], "build"), "");
  console.log("PASS: no checklist produces no note");
}

// 5) Narrowed re-tick must NOT drop earlier open steps (todo-forget/redo bug).
{
  const full = [
    { content: "fix popup sort", status: "completed" },
    { content: "wire history preview", status: "in_progress" },
    { content: "update styles", status: "pending" },
  ];
  const narrowed = [{ content: "wire history preview", status: "pending" }];
  const note = buildResumeNote(
    [
      { plan: full, mode: "build" },
      { plan: narrowed, mode: "build" },
    ],
    "build",
  );
  assert.ok(note.includes("fix popup sort"), "union keeps completed step");
  assert.ok(note.includes("wire history preview"), "union keeps open step");
  assert.ok(note.includes("update styles"), "union keeps narrowed-away step");
  console.log("PASS: narrowed re-tick keeps full checklist");
}

// 6) Completed status never reverts via a later stale snapshot.
{
  const note = buildResumeNote(
    [
      { plan: [{ content: "fix popup sort", status: "completed" }], mode: "build" },
      { plan: [{ content: "fix popup sort", status: "pending" }], mode: "build" },
    ],
    "build",
  );
  assert.equal(note, "", "all-completed union produces no note");
  console.log("PASS: completed never reverts");
}

console.log("ALL RESUME NOTE TESTS PASSED");
