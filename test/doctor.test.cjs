const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "living-docs-doctor-"));
process.env.HOME = path.join(ROOT, "home");
process.env.GIT_CONFIG_GLOBAL = path.join(ROOT, "gitconfig");
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Dana\n\temail = dana@example.com\n[init]\n\tdefaultBranch = main\n");

const { collectChecks } = require("../bin/lib/doctor.cjs");
const install = require("../bin/lib/docs-install.cjs");
const { packagePolicyVersion } = require("../bin/lib/policy-version.cjs");

let n = 0;
const sh = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

// <group>/docs (published to a local bare remote) next to <group>/api
function published({ tooling = true, policy = null } = {}) {
  const group = path.join(ROOT, `group-${++n}`);
  const api = path.join(group, "api");
  const docs = path.join(group, "docs");
  const bare = path.join(ROOT, `remote-${n}.git`);
  fs.mkdirSync(path.join(api, ".living-docs"), { recursive: true });
  fs.mkdirSync(path.join(docs, "modules"), { recursive: true });
  fs.writeFileSync(path.join(docs, "INDEX.md"), "# Docs\n");
  if (tooling) install.installDocsTooling(docs, { owners: ["dana"] });
  if (policy !== null) {
    fs.mkdirSync(path.join(docs, ".living-docs"), { recursive: true });
    fs.writeFileSync(path.join(docs, ".living-docs", "policy.json"), JSON.stringify({ policyVersion: policy }));
  }
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  sh(docs, ["init", "-q", "-b", "main"]);
  sh(docs, ["add", "-A"]);
  sh(docs, ["commit", "-q", "-m", "docs: initial"]);
  sh(docs, ["remote", "add", "origin", bare]);
  sh(docs, ["push", "-q", "-u", "origin", "main"]);
  fs.writeFileSync(path.join(api, ".living-docs", "docs.json"), JSON.stringify({ docsRepo: bare, docsPath: "../docs" }));
  return { api, docs };
}

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
const byLabel = (checks, label) => checks.find((c) => c.label === label);
const ghWith = (prs) => (args) => {
  if (args[0] === "auth") return { ok: true, stdout: "" };
  if (args[0] === "pr" && args[1] === "list") return prs === "fail" ? { ok: false, stdout: "" } : prs === "junk" ? { ok: true, stdout: "not json" } : { ok: true, stdout: JSON.stringify(prs) };
  return { ok: true, stdout: "" };
};

test("policy version: in step is ok; docs behind the tool is a warning with the fix", () => {
  const same = published();
  const ok = byLabel(collectChecks(same.api, { gh: ghWith([]) }), "Documentation policy version");
  assert.equal(ok.level, "ok");
  assert.match(ok.detail, new RegExp(`v${packagePolicyVersion()}`));

  const behind = published({ tooling: false, policy: packagePolicyVersion() - 1 });
  const warn = byLabel(collectChecks(behind.api, { gh: ghWith([]) }), "Documentation policy version");
  assert.equal(warn.level, "warn");
  assert.match(warn.detail, /docs upgrade/);
});

test("policy version: a tool older than the docs is a failure, because captures are paused", () => {
  const { api } = published({ policy: packagePolicyVersion() + 1 });
  const check = byLabel(collectChecks(api, { gh: ghWith([]) }), "Documentation policy version");
  assert.equal(check.level, "fail");
  assert.match(check.detail, /captures are paused/);
});

test("a docs repo without the automation is told how to get it; one with it is ok", () => {
  const label = "Docs repo automation (CI checks, lifecycle, digest)";
  assert.equal(byLabel(collectChecks(published().api, { gh: ghWith([]) }), label).level, "ok");
  const bare = byLabel(collectChecks(published({ tooling: false }).api, { gh: ghWith([]) }), label);
  assert.equal(bare.level, "warn");
  assert.match(bare.detail, /docs upgrade/);
});

test("held Implementation PRs are counted; ones stuck past 14 days are called out by number", () => {
  const { api } = published();
  const fresh = collectChecks(api, { gh: ghWith([{ number: 4, headRefName: "docs/wip/api/feat--x", createdAt: daysAgo(2) }]) });
  assert.equal(byLabel(fresh, "Held Implementation PRs").level, "ok");
  assert.match(byLabel(fresh, "Held Implementation PRs").detail, /1 waiting on their code PRs/);
  assert.equal(byLabel(fresh, "Docs PRs waiting for review"), undefined);

  const stuck = collectChecks(api, {
    gh: ghWith([
      { number: 4, headRefName: "docs/wip/api/feat--x", createdAt: daysAgo(2) },
      { number: 5, headRefName: "docs/wip/api/feat--y", createdAt: daysAgo(20) },
    ]),
  });
  const held = byLabel(stuck, "Held Implementation PRs");
  assert.equal(held.level, "warn");
  assert.match(held.detail, /2 waiting.*1 older than 14 days \(#5\)/);
});

test("other docs PRs (Context, new modules, drift) are reported separately from held ones", () => {
  const { api } = published();
  const checks = collectChecks(api, {
    gh: ghWith([
      { number: 4, headRefName: "docs/wip/api/feat--x", createdAt: daysAgo(1) },
      { number: 6, headRefName: "docs/context-auth-1", createdAt: daysAgo(30) },
      { number: 7, headRefName: "docs/new-domain-billing", createdAt: daysAgo(1) },
    ]),
  });
  assert.equal(byLabel(checks, "Held Implementation PRs").level, "ok");
  const review = byLabel(checks, "Docs PRs waiting for review");
  assert.equal(review.level, "warn");
  assert.match(review.detail, /2; 1 older than 14 days \(#6\)/);
});

test("when GitHub can't be asked the checks say so instead of reporting an empty list", () => {
  const { api } = published();
  assert.equal(byLabel(collectChecks(api, { gh: ghWith("fail") }), "Docs PRs").level, "warn");
  assert.equal(byLabel(collectChecks(api, { gh: ghWith("junk") }), "Docs PRs").level, "warn");
  const signedOut = collectChecks(api, { gh: (args) => (args[0] === "auth" ? { ok: false, stdout: "" } : assert.fail("must not list PRs when signed out")) });
  assert.equal(byLabel(signedOut, "`gh` installed and signed in").level, "warn");
});

test("a local-only docs folder gets none of the published-repo checks", () => {
  const group = path.join(ROOT, `group-${++n}`);
  const api = path.join(group, "api");
  fs.mkdirSync(path.join(api, ".living-docs"), { recursive: true });
  fs.mkdirSync(path.join(group, "docs"), { recursive: true });
  fs.writeFileSync(path.join(group, "docs", "INDEX.md"), "# Docs\n");
  fs.writeFileSync(path.join(api, ".living-docs", "docs.json"), JSON.stringify({ docsRepo: null, docsPath: "../docs" }));
  const checks = collectChecks(api, { gh: ghWith([]) });
  assert.equal(byLabel(checks, "Documentation policy version"), undefined);
  assert.equal(byLabel(checks, "Held Implementation PRs"), undefined);
  assert.equal(byLabel(checks, "Shared docs repo").level, "warn");
});
