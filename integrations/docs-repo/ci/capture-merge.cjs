#!/usr/bin/env node
const { spawnSync } = require("child_process");
const { lib, summary } = require("./_lib.cjs");
const { git } = lib("git");
const { captureIntoRepo } = lib("docs-sync");
const { claudeExtractor } = lib("hooks");

// Runs in a CODE repo's workflow when a PR merges (see workflows/docs-capture.yml).
// Developers on Claude Code already have their sessions captured by hooks;
// this covers everyone else (Cursor, plain editors) from what the PR itself says
// and changed. The merge is the moment the code became true, so nothing is held.
//
// Env: PR_NUMBER, PR_TITLE, PR_BODY, PR_HEAD_REF, PR_URL, GITHUB_REPOSITORY,
//      DOCS_REPO_URL, DOCS_CHECKOUT (a checkout of the docs repo, for the skip check)

const MAX_DIFF = 20000;

// The developer's hooks already filed this branch: stamps and trailers say so.
function alreadyCaptured({ docsDir, repoName, headRef }) {
  const found = git(docsDir, ["log", "--all", "--fixed-strings", "--grep", `Source-Repo: ${repoName}`, "--grep", `Source-Branch: ${headRef}`, "--all-match", "-1", "--format=%H"]);
  return found.ok && found.stdout !== "";
}

function pullText({ title, body, url, commits, files, diff }) {
  return [
    `[pull request] ${title}`,
    url ? `(${url})` : "",
    body ? `[description]\n${body}` : "",
    commits.length ? `[commits]\n${commits.map((c) => `- ${c}`).join("\n")}` : "",
    files.length ? `[files changed]\n${files.slice(0, 80).join("\n")}` : "",
    diff ? `[diff, truncated]\n${diff.slice(0, MAX_DIFF)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function ghJson(args, fallback) {
  const r = spawnSync("gh", args, { encoding: "utf-8", timeout: 60000 });
  try {
    return r.status === 0 ? JSON.parse(r.stdout) : fallback;
  } catch {
    return fallback;
  }
}

function run(env = process.env, { capture = captureIntoRepo, extractor = claudeExtractor } = {}) {
  const repoName = (env.GITHUB_REPOSITORY || "").split("/").pop();
  const headRef = env.PR_HEAD_REF;
  if (!env.DOCS_REPO_URL || !headRef) return { status: "misconfigured" };
  if (env.DOCS_CHECKOUT && alreadyCaptured({ docsDir: env.DOCS_CHECKOUT, repoName, headRef })) return { status: "already-captured" };

  const info = ghJson(["pr", "view", env.PR_NUMBER, "--json", "commits,files"], { commits: [], files: [] });
  const diff = spawnSync("gh", ["pr", "diff", env.PR_NUMBER], { encoding: "utf-8", timeout: 60000, maxBuffer: 20 * 1024 * 1024 }).stdout || "";
  const text = pullText({
    title: env.PR_TITLE || "",
    body: (env.PR_BODY || "").slice(0, 6000),
    url: env.PR_URL,
    commits: (info.commits || []).map((c) => c.messageHeadline),
    files: (info.files || []).map((f) => f.path),
    diff,
  });

  const cwd = process.cwd();
  const log = (m) => console.log(m);
  const extract = extractor({ cwd, text, kind: "pr", logFd: 1 });
  const result = capture({ repoUrl: env.DOCS_REPO_URL, cwd, extract, log, segments: [{ branch: headRef, text, kind: "pr" }], hold: false });
  return result;
}

if (require.main === module) {
  const result = run();
  summary(`### Docs capture for PR #${process.env.PR_NUMBER}\nResult: **${result.status}**`);
}

module.exports = { run, alreadyCaptured, pullText };
