const fs = require("fs");
const os = require("os");
const path = require("path");
const { git, parseOrigin } = require("./git.cjs");
const { resolveDocs } = require("./docs-config.cjs");
const { originOf, defaultBranch } = require("./docs-sync.cjs");
const { policyPath, packagePolicyVersion, writeRecord, recordedVersion } = require("./policy-version.cjs");
const { spawnSync } = require("child_process");

// Installs the docs-repo automation (CI scripts, workflows, policy record) into
// a docs repo, and the merge-capture workflow into a code repo. The sources live
// in the package (integrations/docs-repo, bin/lib); the copy in the docs repo is
// what its GitHub Actions run, so it must be self-contained: the CI scripts load
// their library from .living-docs/ci/lib (see integrations/docs-repo/ci/_lib.cjs).

const PACKAGE_ROOT = path.join(__dirname, "..", "..");
const SOURCE = path.join(PACKAGE_ROOT, "integrations", "docs-repo");
const LIB_SOURCE = path.join(PACKAGE_ROOT, "bin", "lib");

const CI_DIR = path.join(".living-docs", "ci");
const WORKFLOWS_DIR = path.join(".github", "workflows");
const CODE_WORKFLOW = "docs-capture.code.yml";
const CODE_WORKFLOW_DEST = "docs-capture.yml";
const REPO_CONFIG = path.join(".living-docs", "docs-repo.json");

// Only writes when the content differs, so an up-to-date repo produces an empty
// change list (and no upgrade PR).
function writeIfChanged(root, relative, content, changed) {
  const dest = path.join(root, relative);
  const current = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (current && current.equals(next)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, next);
  changed.push(relative);
}

function copyDir(fromDir, root, toRelative, changed, filter = () => true) {
  for (const name of fs.readdirSync(fromDir).sort()) {
    const from = path.join(fromDir, name);
    if (!fs.statSync(from).isFile() || !filter(name)) continue;
    writeIfChanged(root, path.join(toRelative, name), fs.readFileSync(from), changed);
  }
}

// Removes files a previous version installed that this version no longer ships,
// so a renamed or dropped script doesn't linger and keep running.
function pruneDir(root, relative, keep, changed) {
  const dir = path.join(root, relative);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile() && !keep.has(name)) {
      fs.unlinkSync(file);
      changed.push(path.join(relative, name));
    }
  }
}

function normalizeOwners(owners) {
  return [...new Set((owners || []).map((o) => String(o).trim()).filter(Boolean).map((o) => (o.startsWith("@") ? o : `@${o}`)))];
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

// Code repos the drift audit checks out. Additive: a repo somebody listed by
// hand is never dropped just because it wasn't discovered this time.
function mergeCodeRepos(root, codeRepos, changed) {
  const file = path.join(root, REPO_CONFIG);
  const existing = readJson(file, {});
  const current = Array.isArray(existing.codeRepos) ? existing.codeRepos : [];
  const merged = [...new Set([...current, ...codeRepos])].sort();
  const next = { ...existing, codeRepos: merged };
  writeIfChanged(root, REPO_CONFIG, JSON.stringify(next, null, 2) + "\n", changed);
  return merged;
}

// Writes the automation into a docs repo working tree. Does not commit.
// Returns { changed, codeRepos, codeowners } where `codeowners` says what
// happened to .github/CODEOWNERS ("written" | "kept" | "no-owners").
function installDocsTooling(root, { codeRepos = [], owners = [] } = {}) {
  const changed = [];

  const ciFiles = fs.readdirSync(path.join(SOURCE, "ci")).filter((n) => n.endsWith(".cjs"));
  copyDir(path.join(SOURCE, "ci"), root, CI_DIR, changed, (n) => n.endsWith(".cjs"));
  pruneDir(root, CI_DIR, new Set([...ciFiles, "documentation-policy.md"]), changed);

  const libFiles = fs.readdirSync(LIB_SOURCE).filter((n) => n.endsWith(".cjs"));
  copyDir(LIB_SOURCE, root, path.join(CI_DIR, "lib"), changed, (n) => n.endsWith(".cjs"));
  pruneDir(root, path.join(CI_DIR, "lib"), new Set(libFiles), changed);

  // The library finds the policy next to .living-docs/ci as a plain .md (policy-version.cjs).
  writeIfChanged(root, path.join(CI_DIR, "documentation-policy.md"), fs.readFileSync(policyPath()), changed);

  const workflows = fs.readdirSync(path.join(SOURCE, "workflows")).filter((n) => n !== CODE_WORKFLOW && n.endsWith(".yml"));
  copyDir(path.join(SOURCE, "workflows"), root, WORKFLOWS_DIR, changed, (n) => workflows.includes(n));
  // Only workflows this tool owns (docs-*.yml) are pruned; a team's own are left alone.
  const wfDir = path.join(root, WORKFLOWS_DIR);
  if (fs.existsSync(wfDir)) {
    for (const name of fs.readdirSync(wfDir)) {
      if (name.startsWith("docs-") && name.endsWith(".yml") && !workflows.includes(name)) {
        fs.unlinkSync(path.join(wfDir, name));
        changed.push(path.join(WORKFLOWS_DIR, name));
      }
    }
  }

  // CODEOWNERS is a human decision once it exists; never overwritten.
  let codeowners = "kept";
  const ownersFile = path.join(root, ".github", "CODEOWNERS");
  if (!fs.existsSync(ownersFile)) {
    const list = normalizeOwners(owners);
    if (list.length === 0) {
      codeowners = "no-owners";
    } else {
      const template = fs.readFileSync(path.join(SOURCE, "CODEOWNERS.template"), "utf-8");
      writeIfChanged(root, path.join(".github", "CODEOWNERS"), template.replace("@OWNER_PLACEHOLDER", list.join(" ")), changed);
      codeowners = "written";
    }
  }

  if (recordedVersion(root) !== packagePolicyVersion() || !fs.existsSync(path.join(root, ".living-docs", "policy.json"))) {
    writeRecord(root);
    changed.push(path.join(".living-docs", "policy.json"));
  }

  const repos = mergeCodeRepos(root, codeRepos, changed);
  return { changed, codeRepos: repos, codeowners };
}

// The code checkouts that share this docs folder: the project group's other
// repos next to it whose .living-docs/docs.json resolves to the same docs dir.
function discoverCodeDirs(docsDir) {
  const parent = path.dirname(docsDir);
  let entries = [];
  try {
    entries = fs.readdirSync(parent).sort();
  } catch {
    // unreadable parent: nothing to discover
  }
  const found = [];
  for (const name of entries) {
    const candidate = path.join(parent, name);
    if (path.resolve(candidate) === path.resolve(docsDir)) continue;
    if (!fs.existsSync(path.join(candidate, ".living-docs", "docs.json"))) continue;
    const resolved = resolveDocs(candidate);
    if (!resolved || path.resolve(resolved.docsDir) !== path.resolve(docsDir)) continue;
    found.push(candidate);
  }
  return found;
}

// `owner/name` for each of those checkouts that has a GitHub origin, plus any named explicitly.
function discoverCodeRepos(docsDir, extra = []) {
  const found = new Set(extra);
  for (const dir of discoverCodeDirs(docsDir)) {
    const origin = parseOrigin(originOf(dir));
    if (origin) found.add(`${origin.owner}/${origin.repo}`);
  }
  return [...found].sort();
}

function runGh(dir, args) {
  const result = spawnSync("gh", args, { cwd: dir, encoding: "utf-8", timeout: 60000 });
  return { ok: result.status === 0, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim(), missing: result.error && result.error.code === "ENOENT" };
}

// Brings a published docs repo up to this tool's automation. It works in a
// throwaway clone (never the developer's checkout) and proposes the change as a
// PR: the workflows run with the org's secrets, so a person reviews them.
function upgradeDocsRepo({ cwd, extraCodeRepos = [], reviewers = [], run = runGh, tmpRoot = os.tmpdir() }) {
  const docs = resolveDocs(cwd);
  if (!docs) throw new Error("no docs folder found for this project — run `living-docs init --target claude-code` first");
  const repoUrl = docs.repoUrl || originOf(docs.docsDir);
  if (!repoUrl) throw new Error("the docs are not published yet — run `living-docs docs publish` first");

  const codeRepos = discoverCodeRepos(docs.docsDir, [
    ...extraCodeRepos,
    ...(parseOrigin(originOf(cwd)) ? [`${parseOrigin(originOf(cwd)).owner}/${parseOrigin(originOf(cwd)).repo}`] : []),
  ]);

  const work = fs.mkdtempSync(path.join(tmpRoot, "living-docs-docs-upgrade-"));
  const clone = path.join(work, "repo");
  try {
    const cloned = git(work, ["clone", repoUrl, clone], { timeout: 60000 });
    if (!cloned.ok) throw new Error(`could not clone ${repoUrl}: ${cloned.stderr.split("\n")[0]}`);
    const base = defaultBranch(clone);

    const result = installDocsTooling(clone, { codeRepos, owners: [...reviewers, ...docs.reviewers] });
    if (result.changed.length === 0) return { upToDate: true, repoUrl, ...result };

    const version = packagePolicyVersion();
    const branch = `tooling/upgrade-policy-v${version}`;
    git(clone, ["checkout", "-b", branch]);
    git(clone, ["add", "-A"]);
    const identity = { name: "Claude", email: "noreply@anthropic.com" };
    const message = `chore: install docs automation (policy v${version})`;
    const committed = git(clone, ["commit", "-m", message], { identity });
    if (!committed.ok) throw new Error(`could not commit the upgrade: ${committed.stderr.split("\n")[0]}`);
    const pushed = git(clone, ["push", "-u", "origin", branch], { timeout: 60000 });
    if (!pushed.ok) throw new Error(`push of ${branch} failed: ${pushed.stderr.split("\n")[0]}`);

    const body = [
      "Installs or updates the docs automation in this repo: CI checks, the lifecycle engine, the weekly digest and drift audit.",
      "",
      "Files:",
      ...result.changed.map((f) => `- \`${f}\``),
      "",
      "These workflows run with this repo's secrets, so please review them. They need `CODE_REPOS_TOKEN`, `ANTHROPIC_API_KEY` and optionally `SLACK_WEBHOOK_URL` as Actions secrets to do everything; missing ones make a step skip, not fail.",
      "",
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    ].join("\n");
    const pr = run(clone, ["pr", "create", "--base", base, "--head", branch, "--title", message, "--body", body]);
    if (pr.missing) return { pushedBranch: branch, prUrl: null, note: "`gh` is not installed: open a PR for the pushed branch yourself", repoUrl, ...result };
    if (!pr.ok) return { pushedBranch: branch, prUrl: null, note: `gh pr create failed: ${pr.stderr.split("\n")[0]}`, repoUrl, ...result };
    return { pushedBranch: branch, prUrl: pr.stdout.split("\n").pop(), repoUrl, ...result };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Installs the workflow that files a merged PR's decisions into the docs repo.
// It lives in the CODE repo; the docs repo location comes from .living-docs/docs.json.
function enableMergeCapture(cwd) {
  const docs = resolveDocs(cwd);
  const warnings = [];
  if (!docs || docs.source !== "config") warnings.push("this repo has no .living-docs/docs.json; run `living-docs init --target claude-code` and commit it, or the workflow has no docs repo to write to");
  else if (!docs.repoUrl) warnings.push("the docs are not published yet (docsRepo is null in .living-docs/docs.json); run `living-docs docs publish` first");

  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) throw new Error("run this inside the code repo (a git checkout)");
  const changed = [];
  writeIfChanged(root.stdout, path.join(WORKFLOWS_DIR, CODE_WORKFLOW_DEST), fs.readFileSync(path.join(SOURCE, "workflows", CODE_WORKFLOW)), changed);
  return { root: root.stdout, changed, warnings, file: path.join(WORKFLOWS_DIR, CODE_WORKFLOW_DEST) };
}

module.exports = { installDocsTooling, discoverCodeRepos, discoverCodeDirs, upgradeDocsRepo, enableMergeCapture, normalizeOwners, SOURCE, CI_DIR, WORKFLOWS_DIR };
