const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// Implementation edits captured from an unmerged code branch wait on a
// docs/wip/<repo>/<branch> draft PR instead of going to main. Real git for the
// docs remote and the code repo; `claude` and `gh` are stubs.

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "living-docs-held-"));
const HOME = path.join(ROOT, "home");
const BIN = path.join(ROOT, "bin");
const REMOTE = path.join(ROOT, "docs.git");
const GROUP = path.join(ROOT, "acme");
const CODE = path.join(GROUP, "api");
const GH_LOG = path.join(ROOT, "gh-log");

fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });
process.env.HOME = HOME;
delete process.env.XDG_STATE_HOME;
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.GIT_CONFIG_GLOBAL = path.join(HOME, ".gitconfig");
process.env.GH_LOG = GH_LOG;
process.env.CLAUDE_PROMPT = path.join(ROOT, "claude-prompt");
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Dana Dev\n\temail = dana@example.com\n[init]\n\tdefaultBranch = main\n");

const script = (name, body) => fs.writeFileSync(path.join(BIN, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
script("claude", `cat > "$CLAUDE_PROMPT"\n[ -n "$SCENARIO" ] && bash "$SCENARIO"\necho "done"`);
script(
  "gh",
  `echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr list")
    if [[ "$*" == *"--state merged"* ]]; then echo "\${GH_MERGED_JSON:-[]}";
    elif [ -n "$GH_LIST_HEAD" ] && [[ "$*" == *"$GH_LIST_HEAD"* ]]; then echo "$GH_LIST_JSON"; else echo "[]"; fi;;
  "pr create") echo "https://github.com/acme/acme-docs/pull/1";;
esac`
);

const AUTH = "# Auth\n\n## Context\n- Use case: login\n\n## Implementation\n- JWT\n\n## Decision History\n- 2026-01-01: chose JWT over sessions\n";
const BILLING = "# Billing\n\n## Context\n- Use case: invoices\n\n## Implementation\n- Stripe\n\n## Decision History\n- 2026-01-01: chose Stripe\n";

const sh = (cwd, cmd) => {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`);
  return r.stdout.trim();
};
const show = (ref) => sh(REMOTE, `git show ${ref}`);
const remoteBranches = () => sh(REMOTE, "git for-each-ref --format='%(refname:short)' refs/heads/").split("\n");
const scenario = (body) => {
  const file = path.join(ROOT, "scenario.sh");
  fs.writeFileSync(file, body);
  process.env.SCENARIO = file;
};
const ghLog = () => (fs.existsSync(GH_LOG) ? fs.readFileSync(GH_LOG, "utf-8") : "");
const onBranch = (name, from) => sh(CODE, from ? `git checkout -q -b ${name} ${from}` : `git checkout -q ${name}`);

const logs = [];
const log = (m) => logs.push(m);
// The stub model reads the branch it was asked about from its prompt.
const extract = (dir, segment = {}) => {
  const r = spawnSync("claude", ["-p"], { cwd: dir, input: `branch:${segment.branch || "current"}`, encoding: "utf-8" });
  return { output: r.stdout };
};

const { captureIntoRepo } = require("../bin/lib/docs-sync.cjs");
const capture = (o = {}) => captureIntoRepo({ repoUrl: REMOTE, cwd: CODE, extract, log, ...o });
// Adds an Implementation bullet without depending on what is already there.
const impl = (file, text) => `sed -i 's/^## Decision History$/- ${text}\\n\\n## Decision History/' modules/${file}.md`;
const decision = (file, text) => `echo "- 2026-09-20: ${text}" >> modules/${file}.md`;

test.before(() => {
  sh(ROOT, `git init --bare -q ${REMOTE}`);
  const seed = path.join(ROOT, "seed");
  fs.mkdirSync(path.join(seed, "modules"), { recursive: true });
  fs.writeFileSync(path.join(seed, "INDEX.md"), "# acme\n\n## Business domains\n\n- [Auth](modules/auth.md) — auth\n- [Billing](modules/billing.md) — billing\n");
  fs.writeFileSync(path.join(seed, "modules", "auth.md"), AUTH);
  fs.writeFileSync(path.join(seed, "modules", "billing.md"), BILLING);
  sh(seed, `git init -q -b main && git add -A && git commit -q -m seed && git remote add origin ${REMOTE} && git push -q origin main`);
  sh(REMOTE, "git symbolic-ref HEAD refs/heads/main");

  fs.mkdirSync(CODE, { recursive: true });
  sh(CODE, "git init -q -b main && git commit -q --allow-empty -m init && git remote add origin git@github.com:acme/api.git");
});

test("an unmerged branch: Implementation waits on a draft wip PR, the decision goes to main", () => {
  onBranch("feat/a", "main");
  scenario(`${impl("auth", "refresh tokens")}\n${decision("auth", "rotate refresh tokens, to limit replay")}`);
  const result = capture({ segments: [{ branch: "feat/a" }] });
  assert.equal(result.status, "pushed");

  const main = show("main:modules/auth.md");
  assert.doesNotMatch(main, /refresh tokens\n/, "Implementation must not reach main before the code does");
  assert.match(main, /rotate refresh tokens, to limit replay \(src: api@feat\/a [0-9a-f]+\)$/m, "the decision is published, stamped");

  assert.ok(remoteBranches().includes("docs/wip/api/feat--a"));
  const wip = show("docs/wip/api/feat--a:modules/auth.md");
  assert.match(wip, /^- refresh tokens$/m);
  assert.doesNotMatch(wip, /rotate refresh tokens/, "the decision is not duplicated onto the wip branch");

  const create = ghLog().split(/^pr create/m).pop();
  assert.match(create, /--head docs\/wip\/api\/feat--a/);
  assert.match(create, /--draft/);
  assert.match(create, /<!-- living-docs-wip\ncode-repo: acme\/api\ncode-branch: feat\/a\ncode-default: main\n-->/);
  assert.match(ghLog(), /pr list --head docs\/wip\/api\/feat--a --state open/, "only an open PR counts, so a reused branch name gets a fresh one");
});

test("a second capture on the same branch extends the same wip and stays current with main", () => {
  fs.rmSync(GH_LOG, { force: true });
  process.env.GH_LIST_HEAD = "docs/wip/api/feat--a";
  process.env.GH_LIST_JSON = '[{"number":7}]';
  scenario(impl("billing", "invoice webhooks"));
  capture({ segments: [{ branch: "feat/a" }] });
  delete process.env.GH_LIST_HEAD;

  assert.match(show("docs/wip/api/feat--a:modules/billing.md"), /^- invoice webhooks$/m);
  assert.match(show("docs/wip/api/feat--a:modules/auth.md"), /rotate refresh tokens/, "main's decision was merged into the wip");
  assert.doesNotMatch(ghLog(), /pr create/, "the open PR is reused");
  assert.equal(sh(REMOTE, "git rev-list --count docs/wip/api/feat--a ^main --no-merges"), "2");
  assert.doesNotMatch(show("main:modules/billing.md"), /invoice webhooks/);
});

test("on the default branch nothing is held", () => {
  onBranch("main");
  scenario(impl("billing", "SEPA debits"));
  const result = capture();
  assert.equal(result.status, "pushed");
  assert.match(show("main:modules/billing.md"), /^- SEPA debits$/m);
});

test("a project can opt out of holding", () => {
  onBranch("feat/a");
  scenario(impl("auth", "opted out"));
  capture({ hold: false });
  assert.match(show("main:modules/auth.md"), /^- opted out$/m);
});

test("a branch whose PR already merged is pushed directly, but new commits after the merge are held again", () => {
  onBranch("feat/done", "main");
  sh(CODE, "git commit -q --allow-empty -m work");
  const tip = sh(CODE, "git rev-parse HEAD");
  process.env.GH_MERGED_JSON = JSON.stringify([{ headRefOid: tip }]);
  scenario(impl("billing", "merged work"));
  capture({ segments: [{ branch: "feat/done" }] });
  assert.match(show("main:modules/billing.md"), /^- merged work$/m);
  assert.ok(!remoteBranches().includes("docs/wip/api/feat--done"));

  sh(CODE, "git commit -q --allow-empty -m more");
  scenario(impl("auth", "after the merge"));
  capture({ segments: [{ branch: "feat/done" }] });
  delete process.env.GH_MERGED_JSON;
  assert.doesNotMatch(show("main:modules/auth.md"), /after the merge/);
  assert.match(show("docs/wip/api/feat--done:modules/auth.md"), /^- after the merge$/m);
});

test("a branch with no commits of its own is not mistaken for a parent of its siblings", () => {
  const wip = show("docs/wip/api/feat--done:modules/auth.md");
  assert.doesNotMatch(wip, /refresh tokens\n/, "feat/done was cut from main, not from feat/a");
});

test("a branch cut from a held branch stacks its wip (and PR) on the parent's", () => {
  fs.rmSync(GH_LOG, { force: true });
  onBranch("feat/a");
  sh(CODE, "git commit -q --allow-empty -m a-work");
  onBranch("feat/b", "feat/a");
  sh(CODE, "git commit -q --allow-empty -m b-work");
  scenario(impl("billing", "plus B"));
  capture({ segments: [{ branch: "feat/b" }] });

  assert.ok(remoteBranches().includes("docs/wip/api/feat--b"));
  assert.match(show("docs/wip/api/feat--b:modules/billing.md"), /^- plus B$/m);
  assert.match(show("docs/wip/api/feat--b:modules/auth.md"), /^- refresh tokens$/m, "built on the parent's held Implementation");
  assert.match(show("docs/wip/api/feat--b --no-patch --format=%B"), /Docs-Base: docs\/wip\/api\/feat--a/);
  assert.match(show("docs/wip/api/feat--b --no-patch --format=%B"), /parent-code-branch: feat\/a/);
  const create = ghLog().split(/^pr create/m).pop();
  assert.match(create, /--base docs\/wip\/api\/feat--a/, "the PR targets the parent's wip, so it can't reach main first");
});

test("a session that hopped between branches files each branch's edits against its own wip", () => {
  onBranch("main");
  sh(CODE, "git branch feat/c main && git branch feat/d main");
  scenario(`if grep -q 'branch:feat/c' "$CLAUDE_PROMPT"; then ${impl("auth", "C only")}; fi
if grep -q 'branch:feat/d' "$CLAUDE_PROMPT"; then ${impl("billing", "D only")}; fi`);
  const result = capture({ segments: [{ branch: "feat/c" }, { branch: "feat/d" }] });
  assert.deepEqual(result.statuses, ["held", "held"]);

  assert.match(show("docs/wip/api/feat--c:modules/auth.md"), /C only/);
  assert.doesNotMatch(show("docs/wip/api/feat--c:modules/billing.md"), /D only/);
  assert.match(show("docs/wip/api/feat--d:modules/billing.md"), /D only/);
  assert.doesNotMatch(show("docs/wip/api/feat--d:modules/auth.md"), /C only/);
});

test("only decisions on a held branch: main gets them and no empty wip branch is left behind", () => {
  onBranch("main");
  sh(CODE, "git branch feat/e main");
  scenario(decision("auth", "keep sessions server-side"));
  const result = capture({ segments: [{ branch: "feat/e" }] });
  assert.equal(result.status, "pushed");
  assert.match(show("main:modules/auth.md"), /keep sessions server-side \(src: api@feat\/e/);
  assert.ok(!remoteBranches().includes("docs/wip/api/feat--e"));
  const clones = path.join(HOME, ".local/state/living-docs/clones");
  const dir = path.join(clones, fs.readdirSync(clones).find((n) => !n.endsWith(".lock")));
  assert.equal(sh(dir, "git branch --list 'docs/wip/api/feat--e'"), "", "nor a local one");
});

test("a Context edit on a held branch is proposed from main, without the held Implementation", () => {
  onBranch("main");
  sh(CODE, "git branch feat/f main");
  scenario(`sed -i 's/^- Use case: invoices$/- Use case: invoices and credit notes/' modules/billing.md
${impl("billing", "credit-note API")}`);
  capture({ segments: [{ branch: "feat/f" }] });
  const ctx = remoteBranches().find((b) => b.startsWith("docs/context-billing-"));
  assert.ok(ctx, "Context PR branch exists");
  assert.match(show(`${ctx}:modules/billing.md`), /credit notes/);
  assert.doesNotMatch(show(`${ctx}:modules/billing.md`), /credit-note API/, "the Context PR carries Context only");
  assert.match(show("docs/wip/api/feat--f:modules/billing.md"), /credit-note API/);
  assert.match(show("docs/wip/api/feat--f:modules/billing.md"), /Use case: invoices$/m, "wip keeps main's Context");
});

test("hooks: a session that crossed branches is split by the branch each message was on", () => {
  const project = path.join(GROUP, "web");
  fs.mkdirSync(path.join(project, ".living-docs"), { recursive: true });
  fs.writeFileSync(path.join(project, ".living-docs", "docs.json"), JSON.stringify({ docsRepo: REMOTE, docsPath: "../docs" }));
  sh(project, "git init -q -b main && git commit -q --allow-empty -m init && git remote add origin git@github.com:acme/web.git && git branch feat/g && git branch feat/h");
  fs.mkdirSync(path.join(GROUP, "docs"), { recursive: true });

  const turn = (role, gitBranch, text) => JSON.stringify({ type: role, gitBranch, message: { role, content: role === "user" ? text : [{ type: "text", text }] } });
  const talk = (branch, marker) =>
    [0, 1].flatMap((i) => [turn("user", branch, `${marker} q${i} ${"why is this failing? ".repeat(20)}`), turn("assistant", branch, `${marker} a${i} ${"because of X. ".repeat(20)}`)]);
  const transcript = path.join(ROOT, "hop.jsonl");
  fs.writeFileSync(transcript, [...talk("feat/g", "GGG"), ...talk("feat/h", "HHH")].join("\n") + "\n");

  scenario(`if grep -q 'branch "feat/g"' "$CLAUDE_PROMPT"; then ${impl("auth", "hook G")}; fi
if grep -q 'branch "feat/h"' "$CLAUDE_PROMPT"; then ${impl("billing", "hook H")}; fi`);
  const cli = path.join(__dirname, "..", "bin", "living-docs.cjs");
  const run = spawnSync("node", [cli, "hook", "capture-session"], {
    input: JSON.stringify({ cwd: project, session_id: "hop-1", transcript_path: transcript }),
    encoding: "utf-8",
  });
  assert.equal(run.status, 0);

  const logPath = path.join(HOME, ".local", "state", "living-docs", "capture.log");
  const deadline = Date.now() + 30000;
  let text = "";
  while (Date.now() < deadline && !/processed session for cwd=.*web \(/.test(text)) {
    text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  assert.match(text, /processed session for cwd=.*web \(/);
  assert.ok(remoteBranches().includes("docs/wip/web/feat--g"));
  assert.ok(remoteBranches().includes("docs/wip/web/feat--h"));
  assert.match(show("docs/wip/web/feat--g:modules/auth.md"), /^- hook G$/m);
  assert.doesNotMatch(show("docs/wip/web/feat--g:modules/billing.md"), /hook H/);
  assert.match(show("docs/wip/web/feat--h:modules/billing.md"), /^- hook H$/m);
  assert.doesNotMatch(show("main:modules/auth.md"), /hook G/);
});
