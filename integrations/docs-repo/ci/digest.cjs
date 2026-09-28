#!/usr/bin/env node
const path = require("path");
const { spawnSync } = require("child_process");
const { lib, summary, slack } = require("./_lib.cjs");
const { git } = lib("git");

// Weekly health digest. The capture pipeline runs on developers' machines, where
// a broken hook fails silently, so the docs repo watches for the *absence* of
// captures as well as for what is waiting on people.

const DAY = 24 * 60 * 60 * 1000;

function captures(dir, since) {
  const log = git(dir, ["log", "main", `--since=${new Date(since).toISOString()}`, "--format=%H%x1f%aI%x1f%s%x1f%b%x1e"]);
  return log.stdout
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, date, subject, body] = r.split("\x1f");
      return { sha, date, subject, repo: (/^Source-Repo: (.+)$/m.exec(body || "") || [])[1] || null, automated: /Captured-By: living-docs/.test(body || "") };
    });
}

function lastCapture(dir) {
  const r = git(dir, ["log", "main", "--grep=Captured-By: living-docs", "-1", "--format=%aI"]);
  return r.stdout || null;
}

function build({ dir = process.cwd(), now = Date.now(), prs = [] }) {
  const week = captures(dir, now - 7 * DAY);
  const auto = week.filter((c) => c.automated);
  const last = lastCapture(dir);
  const silentDays = last ? Math.floor((now - Date.parse(last)) / DAY) : null;

  const wip = prs.filter((p) => p.headRefName.startsWith("docs/wip/"));
  const rest = prs.filter((p) => !p.headRefName.startsWith("docs/wip/"));
  const old = rest.filter((p) => now - Date.parse(p.createdAt) > 14 * DAY);
  const perRepo = {};
  auto.forEach((c) => (perRepo[c.repo || "unknown"] = (perRepo[c.repo || "unknown"] || 0) + 1));

  const lines = [
    "### Docs health, last 7 days",
    `- Automated captures: **${auto.length}**${Object.keys(perRepo).length ? ` (${Object.entries(perRepo).map(([r, n]) => `${r}: ${n}`).join(", ")})` : ""}`,
    `- Human edits: ${week.length - auto.length}`,
    `- Held Implementation waiting on code: ${wip.length}`,
    `- PRs waiting for review: ${rest.length}${old.length ? ` (${old.length} older than 14 days)` : ""}`,
  ];
  const warnings = [];
  if (silentDays === null) warnings.push("no automated capture has ever landed here — are the hooks installed? (`living-docs doctor`)");
  else if (silentDays >= 7) warnings.push(`no automated capture for ${silentDays} days — check \`living-docs doctor\` on a developer machine`);
  return { text: [...lines, ...warnings.map((w) => `- :warning: ${w}`)].join("\n"), warnings, auto: auto.length, silentDays };
}

async function main() {
  const gh = spawnSync("gh", ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName,createdAt"], { encoding: "utf-8" });
  let prs = [];
  try {
    prs = JSON.parse(gh.stdout || "[]");
  } catch {
    // digest still useful without the PR counts
  }
  const result = build({ dir: path.resolve("."), prs });
  summary(result.text);
  const sent = await slack(result.text.replace(/^### /, "*").replace(/\n/, "*\n"));
  if (!sent.sent) console.log(`Slack: ${sent.reason}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { build };
