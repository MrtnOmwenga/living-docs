const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ruleContent, writeCursorDocsRule } = require("../bin/lib/cursor-docs.cjs");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "living-docs-cursor-"));
let n = 0;

// <group>/docs (with an INDEX) next to <group>/api
function project({ config = null, index = true } = {}) {
  const group = path.join(ROOT, `group-${++n}`);
  const api = path.join(group, "api");
  fs.mkdirSync(path.join(api, ".living-docs"), { recursive: true });
  fs.writeFileSync(path.join(api, "package.json"), JSON.stringify({ name: "api", dependencies: { "@nestjs/core": "1" } }));
  if (index) {
    fs.mkdirSync(path.join(group, "docs"), { recursive: true });
    fs.writeFileSync(path.join(group, "docs", "INDEX.md"), "# Docs\n");
  }
  if (config) fs.writeFileSync(path.join(api, ".living-docs", "docs.json"), JSON.stringify(config));
  return api;
}

test("the rule always applies and points at the INDEX by its real relative path", () => {
  const api = project({ config: { docsRepo: null, docsPath: "../docs" } });
  const rule = ruleContent(api);
  assert.match(rule, /^---\ndescription: .+\nalwaysApply: true\n---/);
  assert.match(rule, /`\.\.\/docs\/INDEX\.md`/);
  assert.match(rule, /never override the rules/);
  assert.match(rule, /Context.*Implementation.*Decision History/s);
  assert.doesNotMatch(rule, /git clone/); // nothing published yet: no URL to clone
});

test("a published docs repo adds the clone and pull commands for a machine that lacks the docs", () => {
  const api = project({ config: { docsRepo: "git@github.com:acme/acme-docs.git", docsPath: "../docs" } });
  const rule = ruleContent(api);
  assert.match(rule, /git clone git@github\.com:acme\/acme-docs\.git \.\.\/docs/);
  assert.match(rule, /pull --ff-only/);
});

test("a custom docsPath in .living-docs/docs.json is honoured, not the sibling-folder default", () => {
  const api = project({ config: { docsRepo: null, docsPath: "vendor/docs" } });
  fs.mkdirSync(path.join(api, "vendor", "docs"), { recursive: true });
  fs.writeFileSync(path.join(api, "vendor", "docs", "INDEX.md"), "# Docs\n");
  assert.match(ruleContent(api), /`vendor\/docs\/INDEX\.md`/);
});

test("how a Cursor developer's decisions reach the docs depends on merge capture being installed", () => {
  const api = project({ config: { docsRepo: null, docsPath: "../docs" } });
  assert.match(ruleContent(api), /so they can be filed into the docs/);
  fs.mkdirSync(path.join(api, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(api, ".github", "workflows", "docs-capture.yml"), "name: x");
  assert.match(ruleContent(api), /A workflow files the merged PR into the docs/);
});

test("no docs at all writes nothing; a published repo with no local copy still gets the rule", () => {
  const bare = project({ index: false });
  assert.equal(ruleContent(bare), null);
  assert.equal(writeCursorDocsRule(bare).status, "skipped");
  assert.ok(!fs.existsSync(path.join(bare, ".cursor")));

  // configured, but nothing published and no local copy: there is nothing to point at
  assert.equal(ruleContent(project({ index: false, config: { docsRepo: null, docsPath: "../docs" } })), null);

  const remoteOnly = project({ index: false, config: { docsRepo: "git@github.com:acme/acme-docs.git", docsPath: "../docs" } });
  assert.match(ruleContent(remoteOnly), /git clone/);
});

test("writing is idempotent and refreshes the file when the docs location changes", () => {
  const api = project({ config: { docsRepo: null, docsPath: "../docs" } });
  assert.equal(writeCursorDocsRule(api).status, "created");
  assert.equal(writeCursorDocsRule(api).status, "unchanged");
  fs.writeFileSync(path.join(api, ".living-docs", "docs.json"), JSON.stringify({ docsRepo: "git@github.com:acme/acme-docs.git", docsPath: "../docs" }));
  assert.equal(writeCursorDocsRule(api).status, "updated");
  assert.match(fs.readFileSync(path.join(api, ".cursor", "rules", "project-docs.mdc"), "utf-8"), /git clone/);
});

test("`init --target cursor` writes the rule; `--target both` also imports the INDEX in CLAUDE.md", () => {
  const api = project({ config: { docsRepo: null, docsPath: "../docs" } });
  const env = { ...process.env, HOME: path.join(ROOT, "home") };
  fs.mkdirSync(env.HOME, { recursive: true });
  const bin = path.join(__dirname, "..", "bin", "living-docs.cjs");

  const cursor = spawnSync("node", [bin, "init", "--target", "cursor"], { cwd: api, encoding: "utf-8", env });
  assert.equal(cursor.status, 0, cursor.stderr + cursor.stdout);
  assert.match(cursor.stdout, /project-docs\.mdc/);
  assert.ok(fs.existsSync(path.join(api, ".cursor", "rules", "project-docs.mdc")));

  const both = spawnSync("node", [bin, "init", "--target", "both", "--no-hooks", "--domains", "none"], { cwd: api, encoding: "utf-8", env });
  assert.equal(both.status, 0, both.stderr + both.stdout);
  assert.match(fs.readFileSync(path.join(api, "CLAUDE.md"), "utf-8"), /@\.\.\/docs\/INDEX\.md/);
  // The policy is imported from a copy in the repo, not from wherever the package is installed,
  // so the committed CLAUDE.md works for everyone who clones it.
  assert.match(fs.readFileSync(path.join(api, "CLAUDE.md"), "utf-8"), /^@\.living-docs\/documentation-policy\.md$/m);
  assert.match(fs.readFileSync(path.join(api, ".living-docs", "documentation-policy.md"), "utf-8"), /policy-version/);
  assert.match(both.stdout, /Already current/);
});

test("`init --target cursor` in a project with no docs says so instead of writing a dangling rule", () => {
  const api = project({ index: false });
  const env = { ...process.env, HOME: path.join(ROOT, "home") };
  const r = spawnSync("node", [path.join(__dirname, "..", "bin", "living-docs.cjs"), "init", "--target", "cursor"], { cwd: api, encoding: "utf-8", env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /No project docs found/);
  assert.ok(!fs.existsSync(path.join(api, ".cursor", "rules", "project-docs.mdc")));
});
