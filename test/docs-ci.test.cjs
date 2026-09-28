const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const CI = path.join(__dirname, "..", "integrations", "docs-repo", "ci");
const { lifecycle, parseMarker } = require(path.join(CI, "lifecycle.cjs"));

// ---- lifecycle: a fake gh, so the decisions are tested without a network ----

const NOW = Date.parse("2026-10-01T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });

const marker = (o = {}) =>
  `body\n\n<!-- living-docs-wip\ncode-repo: ${o.repo || "acme/api"}\ncode-branch: ${o.branch || "feat/x"}\ncode-default: main\n${o.parent ? `parent-code-branch: ${o.parent}\n` : ""}-->`;
const wipPr = (o = {}) => ({
  number: 10,
  title: "docs: api@feat/x (held until the code merges)",
  body: marker(o),
  headRefName: o.head || "docs/wip/api/feat--x",
  baseRefName: o.base || "main",
  isDraft: true,
  createdAt: daysAgo(o.age ?? 3),
  updatedAt: daysAgo(1),
  labels: [],
  mergeable: "MERGEABLE",
  url: "https://github.com/acme/acme-docs/pull/10",
  comments: [],
  ...o.extra,
});
const plainPr = (o = {}) => ({ number: 20, title: "docs: Context change for auth (needs review)", body: "", headRefName: "docs/context-auth-1", baseRefName: "main", isDraft: false, createdAt: daysAgo(o.age ?? 1), updatedAt: daysAgo(1), labels: [], mergeable: "MERGEABLE", url: "https://github.com/acme/acme-docs/pull/20", comments: [], ...o.extra });

function run({ prs, code = {}, mergeFails = 0, config = {} }) {
  const calls = [];
  let merges = 0;
  const gh = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify(prs));
    if (args[0] === "pr" && args[1] === "merge") return ++merges > mergeFails ? ok() : { ok: false, stdout: "", stderr: "Pull request is not mergeable" };
    return ok();
  };
  const codeGh = (args) => {
    const head = args[args.indexOf("--head") + 1];
    const found = code[head];
    if (found === "error") return { ok: false, stdout: "", stderr: "Could not resolve to a Repository" };
    return ok(JSON.stringify(found || []));
  };
  const out = lifecycle({ gh, codeGh, now: NOW, config, defaultBranch: "main" });
  return { out, calls };
}
const codePr = (o) => ({ number: 5, state: "MERGED", mergedAt: daysAgo(1), closedAt: daysAgo(1), createdAt: daysAgo(4), baseRefName: "main", url: "https://github.com/acme/api/pull/5", ...o });

test("marker: the code link is read back from the PR body", () => {
  assert.deepEqual(parseMarker(marker({ parent: "feat/a" })), { codeRepo: "acme/api", codeBranch: "feat/x", codeDefault: "main", parentCodeBranch: "feat/a" });
  assert.equal(parseMarker("no marker here"), null);
});

test("the code PR merged: the draft docs PR is marked ready and squash-merged", () => {
  const { out, calls } = run({ prs: [wipPr()], code: { "feat/x": [codePr()] } });
  assert.deepEqual(out.merged, [10]);
  assert.ok(calls.includes("pr ready 10"));
  assert.ok(calls.includes("pr merge 10 --squash --delete-branch"));
});

test("the code PR is still open: nothing merges, and the link is commented once", () => {
  const open = codePr({ state: "OPEN", mergedAt: null });
  const first = run({ prs: [wipPr()], code: { "feat/x": [open] } });
  assert.deepEqual(first.out.merged, []);
  assert.equal(first.calls.filter((c) => c.startsWith("pr comment 10")).length, 1);
  assert.deepEqual(first.out.waiting.map((w) => w.codePr), [5]);

  const commented = wipPr({ extra: { comments: [{ body: "<!-- living-docs:code-pr -->\nWaiting", createdAt: daysAgo(1) }] } });
  const second = run({ prs: [commented], code: { "feat/x": [open] } });
  assert.equal(second.calls.filter((c) => c.startsWith("pr comment")).length, 0, "no duplicate comment");
});

test("a held PR whose code PR is still open is never treated as stale, however long it takes", () => {
  const open = codePr({ state: "OPEN", mergedAt: null });
  const old = wipPr({ age: 90, extra: { comments: [{ body: "<!-- living-docs:stale-reminder -->", createdAt: daysAgo(60) }] } });
  const { out } = run({ prs: [old], code: { "feat/x": [open] } });
  assert.deepEqual([out.reminded, out.closedStale], [[], []]);
});

test("the code PR was closed without merging: the docs PR is closed with it", () => {
  const { out, calls } = run({ prs: [wipPr()], code: { "feat/x": [codePr({ state: "CLOSED", mergedAt: null })] } });
  assert.deepEqual(out.closedWithCode, [10]);
  assert.ok(calls.some((c) => c.startsWith("pr close 10 --delete-branch")));
  assert.ok(!calls.some((c) => c.startsWith("pr merge")));
});

test("a code PR that finished before the docs PR existed (a reused branch name) is not its code", () => {
  const before = codePr({ mergedAt: daysAgo(30), createdAt: daysAgo(40) });
  const { out, calls } = run({ prs: [wipPr({ age: 3 })], code: { "feat/x": [before] } });
  assert.deepEqual(out.merged, []);
  assert.ok(!calls.some((c) => c.startsWith("pr merge")));
});

test("a merge that is blocked leaves the PR labelled ready and asks a human", () => {
  const { out, calls } = run({ prs: [wipPr()], code: { "feat/x": [codePr()] }, mergeFails: 2 });
  assert.deepEqual(out.merged, []);
  assert.ok(calls.includes("pr merge 10 --squash --auto --delete-branch"), "auto-merge is tried before giving up");
  assert.ok(calls.includes("pr edit 10 --add-label ready-to-merge"));
  assert.equal(out.needsHuman[0].why, "merge blocked");
});

test("a conflict is labelled and flagged instead of merged", () => {
  const { out, calls } = run({ prs: [wipPr({ extra: { mergeable: "CONFLICTING" } })], code: { "feat/x": [codePr()] } });
  assert.deepEqual(out.merged, []);
  assert.ok(calls.includes("pr edit 10 --add-label needs-rebase"));
  assert.equal(out.needsHuman[0].why, "merge conflict");
});

test("stacked docs: merge into the parent's docs only when the code went into the parent's branch", () => {
  const parent = wipPr({ head: "docs/wip/api/feat--a", branch: "feat/a", extra: { number: 9 } });
  const child = (o) => wipPr({ base: "docs/wip/api/feat--a", parent: "feat/a", extra: o });

  const into = run({ prs: [parent, child()], code: { "feat/x": [codePr({ baseRefName: "feat/a" })], "feat/a": [codePr({ state: "OPEN", mergedAt: null, number: 4 })] } });
  assert.deepEqual(into.out.merged, [10], "code B merged into A, so docs B merge into docs A");

  const skipped = run({ prs: [parent, child()], code: { "feat/x": [codePr({ baseRefName: "main" })], "feat/a": [codePr({ state: "OPEN", mergedAt: null, number: 4 })] } });
  assert.deepEqual(skipped.out.merged, [], "code went to main while A is unmerged: wait");
  assert.equal(skipped.out.needsHuman[0].why, "stacked on a docs PR that hasn't merged");
});

test("when the parent's docs have merged and their branch is gone, the child is retargeted to main", () => {
  const { calls } = run({ prs: [wipPr({ base: "docs/wip/api/feat--a", parent: "feat/a" })], code: { "feat/x": [codePr({ state: "OPEN", mergedAt: null })] } });
  assert.ok(calls.includes("pr edit 10 --base main"));
});

test("a code repo the workflow can't read is reported once, not treated as 'no PR'", () => {
  const { out, calls } = run({ prs: [wipPr()], code: { "feat/x": "error" } });
  assert.match(out.errors[0], /acme\/api/);
  assert.equal(calls.filter((c) => c.startsWith("pr comment")).length, 1);
  assert.match(calls.find((c) => c.startsWith("pr comment")), /CODE_REPOS_TOKEN/);
  assert.ok(!calls.some((c) => c.startsWith("pr close")), "an unreadable repo must never close a PR");
});

test("stale: a reminder after 14 idle days, a close 16 days after the reminder, never sooner", () => {
  assert.deepEqual(run({ prs: [plainPr({ age: 10 })] }).out.reminded, []);
  assert.deepEqual(run({ prs: [plainPr({ age: 15 })] }).out.reminded, [20]);

  const reminded = (daysSince, extraComments = []) =>
    plainPr({ age: 40, extra: { comments: [{ body: "<!-- living-docs:stale-reminder -->\n...", createdAt: daysAgo(daysSince) }, ...extraComments] } });
  assert.deepEqual(run({ prs: [reminded(10)] }).out.closedStale, [], "too soon after the reminder");
  const closed = run({ prs: [reminded(17)] });
  assert.deepEqual(closed.out.closedStale, [20]);
  assert.ok(closed.calls.includes("pr edit 20 --add-label stale-closed"), "so a stale close isn't taken for a rejection");
  assert.ok(closed.calls.some((c) => c.startsWith("pr close 20 --delete-branch")));
});

test("stale: a human comment after the reminder, or the keep-open label, keeps the PR alive", () => {
  const remindedAt = daysAgo(20);
  const bot = { body: "<!-- living-docs:stale-reminder -->\n...", createdAt: remindedAt };
  const talked = plainPr({ age: 40, extra: { comments: [bot, { body: "looking at this", createdAt: daysAgo(2) }] } });
  assert.deepEqual(run({ prs: [talked] }).out.closedStale, []);
  const kept = plainPr({ age: 40, extra: { labels: [{ name: "keep-open" }], comments: [bot] } });
  assert.deepEqual(run({ prs: [kept] }).out.closedStale, []);
});

test("a held PR with no code PR follows the same reminder/close path", () => {
  const { out } = run({ prs: [wipPr({ age: 20 })], code: { "feat/x": [] } });
  assert.deepEqual(out.reminded, [10]);
});
