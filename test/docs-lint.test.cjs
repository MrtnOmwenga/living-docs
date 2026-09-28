const test = require("node:test");
const assert = require("node:assert/strict");
const lint = require("../bin/lib/docs-lint.cjs");
const { moduleStub } = require("../bin/lib/docs-modules.cjs");

const doc = (over = {}) =>
  `# Auth

## Context
- Use case: ${over.context || "login"}

## Implementation
- ${over.impl || "JWT"}

## Decision History
${over.history ?? "- 2026-01-01: chose JWT, over sessions"}
`;

test("getSection / replaceSection keep the rest of the file's layout", () => {
  const md = doc();
  assert.equal(lint.getSection(md, "Context"), "\n- Use case: login".replace(/^\n/, ""));
  const out = lint.replaceSection(md, "Context", "- Use case: sso");
  assert.equal(lint.getSection(out, "Context"), "- Use case: sso");
  assert.equal(lint.getSection(out, "Implementation"), lint.getSection(md, "Implementation"));
  assert.equal(out.split("\n").length, md.split("\n").length);
});

test("headings inside code fences are not section boundaries", () => {
  const md = "# X\n\n## Context\n```\n## Implementation\n```\n- a\n\n## Implementation\n- b\n";
  assert.match(lint.getSection(md, "Context"), /- a/);
  assert.equal(lint.getSection(md, "Implementation"), "- b");
});

test("contextChanged ignores whitespace-only differences and other sections", () => {
  assert.equal(lint.contextChanged(doc(), doc({ impl: "sessions" })), false);
  assert.equal(lint.contextChanged(doc(), doc({ context: "login  " })), false);
  assert.equal(lint.contextChanged(doc(), doc({ context: "sso" })), true);
});

test("Decision History is append-only", () => {
  const before = doc();
  const appended = doc({ history: "- 2026-01-01: chose JWT, over sessions\n- 2026-02-01: added refresh" });
  const edited = doc({ history: "- 2026-01-01: chose sessions" });
  const removed = doc({ history: "" });
  assert.equal(lint.appendOnly(before, appended), true);
  // a new entry above the old one is still append-only: nothing existing changed
  assert.equal(lint.appendOnly(doc({ history: "- 2026-01-01: a\n- 2026-02-01: b" }), doc({ history: "- 2026-09-20: new\n- 2026-01-01: a\n- 2026-02-01: b" })), true);
  // reordering or rewording existing entries is not
  assert.equal(lint.appendOnly(doc({ history: "- 2026-01-01: a\n- 2026-02-01: b" }), doc({ history: "- 2026-02-01: b\n- 2026-01-01: a" })), false);
  assert.equal(lint.appendOnly(doc({ history: "- 2026-01-01: a" }), doc({ history: "- 2026-01-01: a, reworded" })), false);
  assert.equal(lint.appendOnly(before, edited), false);
  assert.equal(lint.appendOnly(before, removed), false);
});

test("the stub's empty bullet is a placeholder, so the first entry may replace it", () => {
  const stub = moduleStub("Auth", "auth");
  const filled = stub.replace("## Decision History\n- \n", "## Decision History\n- 2026-09-20: chose JWT\n");
  assert.equal(lint.appendOnly(stub, filled), true);
  assert.deepEqual(lint.lintChange({ slug: "auth", before: stub, after: filled }), []);
});

test("shape: a regression is flagged, an already-nonconforming file is not", () => {
  const broken = doc().replace("## Implementation", "## Impl");
  assert.equal(lint.lintChange({ slug: "auth", before: doc(), after: broken }).length > 0, true);
  const legacy = "# Secrets\n\nfree-form notes\n";
  assert.deepEqual(lint.lintChange({ slug: "secrets-management", before: legacy, after: legacy + "more\n" }), []);
});

test("list modules: entries may be added or edited, not removed", () => {
  const before = "# Glossary\n\n## Terms\n\n- **SKU** — a unit.\n- **Lot** — a batch.\n";
  const added = before + "- **Tenant** — a customer.\n";
  const dropped = "# Glossary\n\n## Terms\n\n- **SKU** — a unit.\n";
  assert.deepEqual(lint.lintChange({ slug: "glossary", before, after: added }), []);
  assert.equal(lint.lintChange({ slug: "glossary", before, after: dropped }).length, 1);
});

test("secrets are caught only in added lines", () => {
  const key = "AKIAABCDEFGHIJKLMNOP";
  const before = doc({ impl: `uses ${key}` });
  assert.deepEqual(lint.findSecrets(before, before), []);
  assert.deepEqual(lint.findSecrets(doc(), doc({ impl: `uses ${key}` })), ["AWS access key"]);
  assert.deepEqual(lint.findSecrets("", "password = hunter2hunter2hunter2"), ["hardcoded credential"]);
  assert.deepEqual(lint.findSecrets("", "the password reset flow sends an email"), []);
});

test("checkIndex reports missing and dangling links", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-"));
  fs.mkdirSync(path.join(dir, "modules"));
  fs.writeFileSync(path.join(dir, "modules", "a.md"), "#a");
  fs.writeFileSync(path.join(dir, "modules", "b.md"), "#b");
  fs.writeFileSync(path.join(dir, "INDEX.md"), "- [A](modules/a.md) — a\n- [C](modules/c.md) — c\n");
  assert.deepEqual(lint.checkIndex(dir).sort(), [
    "INDEX.md links modules/c.md, which does not exist",
    "modules/b.md is not listed in INDEX.md",
  ]);
});

test("a legacy file gaining a Context section counts as a Context change", () => {
  const legacy = "# Notes\n\n## Implementation\n- a\n";
  const gained = "# Notes\n\n## Context\n- Use case: x\n\n## Implementation\n- a\n";
  assert.equal(lint.contextChanged(legacy, gained), true);
  // main gets everything except Context; the PR branch adds it back
  const main = lint.removeSection(gained, "Context");
  assert.equal(lint.getSection(main, "Context"), null);
  assert.equal(lint.getSection(main, "Implementation"), "- a");
  const restored = lint.setSection(main, "Context", "- Use case: x");
  assert.equal(lint.getSection(restored, "Context"), "- Use case: x");
  assert.ok(restored.indexOf("## Context") < restored.indexOf("## Implementation"));
});

test("removing the Context section is a violation", () => {
  const noContext = doc().replace(/## Context\n- Use case: login\n\n/, "");
  assert.ok(lint.lintChange({ slug: "auth", before: doc(), after: noContext }).length > 0);
});

test("tagNewEntries tags only new entries, on their last line, once", () => {
  const before = doc({ history: "- 2026-01-01: old entry" });
  const after = doc({ history: "- 2026-01-01: old entry\n- 2026-09-20: new entry\n  wrapped second line\n- 2026-09-21: another" });
  const out = lint.tagNewEntries(before, after, "Decision History", "api@feat/x 3466ac2");
  assert.match(out, /^- 2026-01-01: old entry$/m, "existing entry untouched");
  assert.match(out, /^- 2026-09-20: new entry\n  wrapped second line \(src: api@feat\/x 3466ac2\)$/m);
  assert.match(out, /^- 2026-09-21: another \(src: api@feat\/x 3466ac2\)$/m);
  assert.equal(lint.tagNewEntries(before, out, "Decision History", "other@y 1").split("(src:").length - 1, 2, "already-tagged entries are not tagged again");
  // and tagging never breaks the append-only rule for what was there
  assert.equal(lint.appendOnly(before, out), true);
});

test("tagNewEntries works on the stub's placeholder bullet and on list modules", () => {
  const stub = "# X\n\n## Decision History\n- \n";
  const filled = "# X\n\n## Decision History\n- 2026-09-20: first\n";
  assert.match(lint.tagNewEntries(stub, filled, "Decision History", "t"), /first \(src: t\)/);
  const ts = "# T\n\n## Issues\n\n- 2026-09-20 **502 on login** — Cause: x. Fix: y.\n";
  assert.match(lint.tagNewEntries("# T\n\n## Issues\n\n", ts, "Issues", "t"), /Fix: y\. \(src: t\)/);
});
