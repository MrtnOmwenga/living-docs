const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");
const { git, isGitRepo } = require("./git.cjs");
const { resolveDocs } = require("./docs-config.cjs");
const { originOf, cloneLocation } = require("./docs-sync.cjs");
const { checkIndex } = require("./docs-lint.cjs");
const { HOOKS } = require("./claude-settings.cjs");
const { compareVersions } = require("./policy-version.cjs");
const { WIP_PREFIX } = require("./docs-sync.cjs");
const { stateDir, logFile, recentProblems, lineTime } = require("./state.cjs");
const { queuedCount } = require("./proposals.cjs");
const os = require("os");

const ICONS = { ok: "\x1b[32m✓\x1b[0m", warn: "\x1b[33m⚠\x1b[0m", fail: "\x1b[31m✗\x1b[0m" };
const DAY = 24 * 60 * 60 * 1000;

function onPath(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore", shell: "/bin/sh" });
    return true;
  } catch {
    return false;
  }
}

function readLog() {
  try {
    return fs.readFileSync(logFile(), "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// Everything the automation depends on, checked in one place. The point is that
// a hook failing silently is the main long-run risk: this makes it visible.
function defaultGh(args, cwd) {
  const r = spawnSync("gh", args, { cwd, encoding: "utf-8", timeout: 15000 });
  return { ok: r.status === 0, stdout: (r.stdout || "").trim() };
}

// `deps.gh(args, cwd)` is injectable so the checks that ask GitHub can be tested offline.
function collectChecks(cwd, { gh = defaultGh } = {}) {
  const checks = [];
  const add = (level, label, detail = "") => checks.push({ level, label, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 18 ? "ok" : "fail", "Node.js", `v${process.versions.node}${major >= 18 ? "" : " (needs >= 18)"}`);
  add(onPath("living-docs") ? "ok" : "fail", "`living-docs` on PATH", onPath("living-docs") ? "" : "hooks call it by name — npm install -g living-docs");
  add(onPath("claude") ? "ok" : "fail", "`claude` on PATH", onPath("claude") ? "" : "captures can't run without it");

  const settingsFile = path.join(os.homedir(), ".claude", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    const missing = HOOKS.filter(
      ({ event, matcher, command }) =>
        !((settings.hooks || {})[event] || []).some(
          (g) => g.matcher === matcher && (g.hooks || []).some((h) => h.command === command)
        )
    );
    add(missing.length === 0 ? "ok" : "fail", "Hooks registered", missing.length === 0 ? "" : `missing: ${missing.map((m) => m.command).join(", ")} — run living-docs init`);
  } catch {
    add("fail", "Hooks registered", `${settingsFile} unreadable — run living-docs init`);
  }

  const docs = resolveDocs(cwd);
  if (!docs) {
    add("warn", "Project docs", "none found for this directory (living-docs init --target claude-code)");
    return checks;
  }
  add("ok", "Project docs", `${docs.docsDir} (${docs.source === "config" ? ".living-docs/docs.json" : "legacy layout"})`);

  if (!fs.existsSync(docs.docsDir)) {
    add(docs.repoUrl ? "warn" : "fail", "Docs checkout", docs.repoUrl ? "not cloned yet — happens on the next session start" : "folder missing and no docsRepo configured");
  } else if (!isGitRepo(docs.docsDir)) {
    add("warn", "Shared docs repo", "local-only: not shared or backed up (living-docs docs publish --create)");
  } else {
    const origin = originOf(docs.docsDir);
    if (!origin) {
      add("warn", "Shared docs repo", "git repo without an origin remote (living-docs docs publish --repo <url>)");
    } else {
      const reachable = git(docs.docsDir, ["ls-remote", "--exit-code", "origin", "HEAD"], { timeout: 10000 });
      add(reachable.ok ? "ok" : "warn", "Docs remote reachable", reachable.ok ? origin : `${origin}: ${reachable.stderr.split("\n")[0] || "no response"}`);
      if (reachable.ok) {
        git(docs.docsDir, ["fetch", "origin"], { timeout: 15000 });
        const behind = git(docs.docsDir, ["rev-list", "--count", "HEAD..@{u}"]);
        if (behind.ok && Number(behind.stdout) > 0) add("warn", "Docs checkout behind remote", `${behind.stdout} commit(s) — pulled on the next session start`);
      }
      if (docs.repoUrl && docs.repoUrl !== origin) add("warn", ".living-docs/docs.json vs origin", `config says ${docs.repoUrl}, checkout's origin is ${origin}`);
    }
    if (git(docs.docsDir, ["status", "--porcelain"]).stdout) add("warn", "Docs checkout has local edits", "the automation never touches it; commit or discard them");
  }

  if (fs.existsSync(docs.docsDir)) {
    const problems = checkIndex(docs.docsDir);
    add(problems.length === 0 ? "ok" : "warn", "INDEX.md matches modules/", problems.join("; "));
  }

  const ghAuth = gh(["auth", "status"], cwd).ok;
  add(ghAuth ? "ok" : "warn", "`gh` installed and signed in", ghAuth ? "" : "Context changes and new-module proposals can't open PRs without it");

  const lines = readLog();
  const processed = lines.filter((l) => /processed (compaction|session)/.test(l));
  const last = processed.length ? lineTime(processed[processed.length - 1]) : NaN;
  add(Number.isNaN(last) ? "warn" : "ok", "Last capture", Number.isNaN(last) ? "none recorded yet" : `${Math.floor((Date.now() - last) / DAY)} day(s) ago`);

  const problems = recentProblems(7);
  add(problems.length === 0 ? "ok" : "warn", "Failures in the last 7 days", problems.length ? `${problems.length}; latest: ${problems[problems.length - 1].replace(/^\[[^\]]+\]\s*/, "")}` : "");

  // Not failures: the automation enforcing the policy on what the model wrote.
  const enforced = lines.filter((l) => /reverted|dropped/.test(l) && Date.now() - lineTime(l) < 7 * DAY);
  if (enforced.length > 0) add("ok", "Edits blocked by the policy in the last 7 days", `${enforced.length} (details in ${logFile()})`);

  const repoUrl = docs.repoUrl || originOf(docs.docsDir);
  const published = fs.existsSync(docs.docsDir) && isGitRepo(docs.docsDir) && Boolean(originOf(docs.docsDir));
  if (published) {
    // An older tool refuses to write under a newer policy (captures stop), so
    // that is a failure; docs that predate the tool's policy only need upgrading.
    const { tool, docs: recorded, relation } = compareVersions(docs.docsDir);
    if (relation === "older") add("fail", "Documentation policy version", `this tool knows v${tool} but the docs are on v${recorded}, so captures are paused — npm install -g living-docs@latest`);
    else if (relation === "newer") add("warn", "Documentation policy version", `this tool is on v${tool}, the docs on v${recorded} — run living-docs docs upgrade`);
    else add("ok", "Documentation policy version", `v${tool}`);

    const installed = fs.existsSync(path.join(docs.docsDir, ".living-docs", "ci", "lint.cjs"));
    add(installed ? "ok" : "warn", "Docs repo automation (CI checks, lifecycle, digest)", installed ? "" : "not installed — run living-docs docs upgrade");

    if (ghAuth) {
      const listed = gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefName,createdAt,isDraft"], docs.docsDir);
      let prs = null;
      try {
        prs = listed.ok ? JSON.parse(listed.stdout || "[]") : null;
      } catch {
        prs = null;
      }
      if (prs) {
        const age = (pr) => Math.floor((Date.now() - Date.parse(pr.createdAt)) / DAY);
        const held = prs.filter((pr) => pr.headRefName.startsWith(WIP_PREFIX));
        const review = prs.filter((pr) => !pr.headRefName.startsWith(WIP_PREFIX));
        const heldOld = held.filter((pr) => age(pr) > 14);
        const reviewOld = review.filter((pr) => age(pr) > 14);
        const nums = (list) => list.map((pr) => `#${pr.number}`).join(", ");
        if (held.length > 0) {
          add(heldOld.length ? "warn" : "ok", "Held Implementation PRs", heldOld.length ? `${held.length} waiting on their code; ${heldOld.length} older than 14 days (${nums(heldOld)}) — merge the code PR or close the docs PR` : `${held.length} waiting on their code PRs`);
        }
        if (review.length > 0) {
          add(reviewOld.length ? "warn" : "ok", "Docs PRs waiting for review", reviewOld.length ? `${review.length}; ${reviewOld.length} older than 14 days (${nums(reviewOld)})` : `${review.length}`);
        }
      } else {
        add("warn", "Docs PRs", "could not list them (gh failed or returned something unreadable)");
      }
    }
  }
  const queued = queuedCount(repoUrl || null);
  if (queued > 0) {
    add("warn", "Module proposals waiting", repoUrl ? `${queued} — become PRs on the next capture` : `${queued} — held until the docs are published (living-docs docs publish)`);
  }
  if (repoUrl) {
    const clone = cloneLocation(repoUrl).dir;
    if (fs.existsSync(clone)) {
      const pending = git(clone, ["for-each-ref", "--format=%(refname:short)", "refs/heads/docs/"]).stdout.split("\n").filter(Boolean);
      if (pending.length > 0) add("warn", "PRs not opened yet", `${pending.length} pending (${pending.join(", ")}) — retried on the next capture`);
    }
  }
  return checks;
}

function runDoctor(cwd) {
  const checks = collectChecks(cwd);
  console.log("");
  checks.forEach(({ level, label, detail }) => console.log(`${ICONS[level]} ${label}${detail ? ` — ${detail}` : ""}`));
  console.log("");
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

module.exports = { runDoctor, collectChecks };
