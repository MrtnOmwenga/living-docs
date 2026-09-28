const test = require("node:test");
const assert = require("node:assert/strict");
const tr = require("../bin/lib/transcript.cjs");

const user = (content, extra = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (...blocks) => ({ type: "assistant", message: { role: "assistant", content: blocks } });
const text = (t) => ({ type: "text", text: t });

const session = () => [
  { type: "permission-mode" },
  user("Why are users logged out mid-session?"),
  assistant({ type: "thinking", thinking: "SECRET-REASONING" }, text("Refresh tokens rotate on every use.")),
  assistant({ type: "tool_use", name: "Edit", input: { file_path: "/w/api/src/auth/refresh.ts" } }),
  user([{ type: "tool_result", content: "TOOL-OUTPUT-NOISE" }]),
  assistant({ type: "tool_use", name: "Bash", input: { command: "pnpm test auth" } }),
  assistant({ type: "tool_use", name: "Read", input: { file_path: "/w/api/x.ts" } }),
  user("<system-reminder>injected harness text</system-reminder>Let's allow a 30s grace window."),
  { ...assistant(text("SUBAGENT-CHATTER")), isSidechain: true },
  { ...user("meta line"), isMeta: true },
  user("ok do it"),
];

test("condense keeps decisions and changed files, drops noise", () => {
  const out = tr.condense(session(), { cwd: "/w/api" });
  assert.match(out.text, /\[user\] Why are users logged out/);
  assert.match(out.text, /\[assistant\] Refresh tokens rotate/);
  assert.match(out.text, /\(edited src\/auth\/refresh\.ts\)/);
  assert.match(out.text, /\(ran: pnpm test auth\)/);
  assert.match(out.text, /Let's allow a 30s grace window/);
  for (const noise of ["SECRET-REASONING", "TOOL-OUTPUT-NOISE", "injected harness text", "SUBAGENT-CHATTER", "meta line"]) {
    assert.doesNotMatch(out.text, new RegExp(noise), `${noise} should be dropped`);
  }
  assert.doesNotMatch(out.text, /x\.ts/, "reads are not changes");
  assert.equal(out.userTurns, 3);
  assert.equal(out.endOffset, session().length);
});

test("condense starts from an offset, so already-captured turns are skipped", () => {
  const entries = session();
  const out = tr.condense(entries, { from: 8 });
  assert.doesNotMatch(out.text, /Why are users logged out/);
  assert.match(out.text, /ok do it/);
});

test("markerOffset finds the last compaction, in either known spelling", () => {
  assert.equal(tr.markerOffset(session()), 0);
  const a = [user("x"), { type: "system", subtype: "compact_boundary" }, user("summary", { isCompactSummary: true }), user("later")];
  assert.equal(tr.markerOffset(a), 3);
  const b = [user("x"), user("summary", { isCompactSummary: true }), user("later")];
  assert.equal(tr.markerOffset(b), 2);
});

test("a compaction summary is never re-condensed as if the user said it", () => {
  const out = tr.condense([user("SUMMARY-TEXT", { isCompactSummary: true }), user("real")], {});
  assert.doesNotMatch(out.text, /SUMMARY-TEXT/);
});

test("gate: short or thin sessions are skipped without a model call", () => {
  assert.equal(tr.worthCapturing({ userTurns: 2, chars: 99999 }), false);
  assert.equal(tr.worthCapturing({ userTurns: 9, chars: 200 }), false);
  assert.equal(tr.worthCapturing({ userTurns: 3, chars: tr.MIN_CHARS }), true);
});

test("very long sessions keep the opening and the end", () => {
  const big = [user("GOAL-AT-START " + "a".repeat(5000)), ...Array.from({ length: 60 }, (_, i) => user("filler " + "b".repeat(1000) + i)), user("FINAL-DECISION")];
  const out = tr.condense(big, {});
  assert.ok(out.chars <= tr.MAX_CHARS + 200);
  assert.match(out.text, /GOAL-AT-START/);
  assert.match(out.text, /FINAL-DECISION/);
  assert.match(out.text, /middle of the conversation omitted/);
});

test("unparseable lines keep their index so ledger offsets stay valid", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tr-")), "t.jsonl");
  fs.writeFileSync(f, `${JSON.stringify(user("a"))}\nnot json\n${JSON.stringify(user("b"))}\n`);
  const entries = tr.readTranscript(f);
  assert.equal(entries.length, 3);
  assert.equal(entries[1], null);
  assert.equal(tr.readTranscript("/nonexistent").length, 0);
});
