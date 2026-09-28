#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { annotate, summary, slack } = require("./_lib.cjs");

// Keeps the docs repo's open PRs moving, on a schedule:
//
//  * a held-Implementation PR (docs/wip/...) is merged when the code PR it is
//    tied to merges, and closed if that code PR is closed unmerged;
//  * anything else that has sat unreviewed gets a reminder, then an
//    auto-close with a summary (the change can be re-proposed later).
//
// Everything that talks to GitHub goes through the injected `gh` / `codeGh`, so
// the decisions are testable without a network. `codeGh` needs read access to
// the code repos (CODE_REPOS_TOKEN); without it wip PRs are flagged, not lost.

const WIP = "docs/wip/";
const DAY = 24 * 60 * 60 * 1000;
const DEFAULTS = { staleAfterDays: 14, closeAfterDays: 30 };
const LABELS = {
  "stale-closed": ["6a737d", "Closed automatically after going unreviewed"],
  "needs-rebase": ["d93f0b", "Conflicts with the docs default branch; resolve in the PR"],
  "ready-to-merge": ["0e8a16", "Its code merged; merge this docs PR"],
};

function parseMarker(body) {
  const match = /<!--\s*living-docs-wip\s*\n([\s\S]*?)-->/.exec(body || "");
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([a-z-]+):\s*(.+)$/.exec(line.trim());
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields["code-repo"] && fields["code-branch"]
    ? { codeRepo: fields["code-repo"], codeBranch: fields["code-branch"], codeDefault: fields["code-default"] || "main", parentCodeBranch: fields["parent-code-branch"] || null }
    : null;
}

function realGh(token) {
  return (args) => {
    const env = { ...process.env };
    if (token) env.GH_TOKEN = token;
    const r = spawnSync("gh", args, { encoding: "utf-8", env, timeout: 60000 });
    return { ok: r.status === 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
  };
}

function json(gh, args, fallback = null) {
  const r = gh(args);
  if (!r.ok) return fallback;
  try {
    return JSON.parse(r.stdout || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

const TAG = (name) => `<!-- living-docs:${name} -->`;
const isBot = (comment) => (comment.body || "").includes("<!-- living-docs:");

function lifecycle({ gh, codeGh, now = Date.now(), config = {}, defaultBranch = "main" }) {
  const cfg = { ...DEFAULTS, ...config };
  const out = { merged: [], closedWithCode: [], reminded: [], closedStale: [], waiting: [], needsHuman: [], errors: [] };

  for (const [name, [color, description]] of Object.entries(LABELS)) gh(["label", "create", name, "--color", color, "--description", description]);

  const prs = json(
    gh,
    ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,title,body,headRefName,baseRefName,isDraft,createdAt,updatedAt,labels,mergeable,url,comments"],
    []
  );
  const heads = new Set(prs.map((p) => p.headRefName));
  const say = (pr, tag, text) => {
    if ((pr.comments || []).some((c) => (c.body || "").includes(TAG(tag)))) return false;
    gh(["pr", "comment", String(pr.number), "--body", `${TAG(tag)}\n${text}`]);
    return true;
  };
  const flag = (pr, why) => out.needsHuman.push({ number: pr.number, title: pr.title, url: pr.url, why });
  const hasLabel = (pr, name) => (pr.labels || []).some((l) => l.name === name);

  // ---- stale handling, shared by every kind of PR ----
  function stale(pr, what) {
    if (hasLabel(pr, "keep-open")) return;
    const comments = pr.comments || [];
    const reminder = comments.find((c) => (c.body || "").includes(TAG("stale-reminder")));
    const human = comments.filter((c) => !isBot(c));
    const lastActivity = Math.max(Date.parse(pr.createdAt), ...human.map((c) => Date.parse(c.createdAt)));
    const idle = (now - lastActivity) / DAY;

    if (!reminder) {
      if (idle >= cfg.staleAfterDays) {
        say(pr, "stale-reminder", `This ${what} has had no activity for ${Math.floor(idle)} days. It will be closed automatically in ${cfg.closeAfterDays - cfg.staleAfterDays} more days unless someone reviews it or adds the \`keep-open\` label.`);
        out.reminded.push(pr.number);
      }
      return;
    }
    const remindedAt = Date.parse(reminder.createdAt);
    const activeSince = human.some((c) => Date.parse(c.createdAt) > remindedAt);
    if (!activeSince && (now - remindedAt) / DAY >= cfg.closeAfterDays - cfg.staleAfterDays) {
      gh(["pr", "edit", String(pr.number), "--add-label", "stale-closed"]);
      gh([
        "pr", "close", String(pr.number), "--delete-branch", "--comment",
        `${TAG("stale-closed")}\nClosed automatically: no review in ${cfg.closeAfterDays} days. Summary: **${pr.title}**. ` +
          "Nothing was lost — reopen this PR to keep it. If the change is still wanted, the capture pipeline can propose it again.",
      ]);
      out.closedStale.push(pr.number);
    }
  }

  // ---- held Implementation ----
  function codeState(marker, pr) {
    const listed = codeGh(["pr", "list", "--repo", marker.codeRepo, "--head", marker.codeBranch, "--state", "all", "--limit", "10", "--json", "number,state,mergedAt,closedAt,createdAt,baseRefName,url"]);
    if (!listed.ok) return { state: "error", detail: listed.stderr.split("\n")[0] || "gh failed" };
    let list;
    try {
      list = JSON.parse(listed.stdout || "[]");
    } catch {
      return { state: "error", detail: "unreadable response" };
    }
    const docsCreated = Date.parse(pr.createdAt);
    list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const open = list.find((p) => p.state === "OPEN");
    if (open) return { state: "open", pr: open };
    const latest = list[0];
    // A PR that finished before this docs PR existed belongs to earlier work on
    // a reused branch name, not to what is waiting here.
    if (latest && latest.state === "MERGED" && Date.parse(latest.mergedAt) >= docsCreated) return { state: "merged", pr: latest };
    if (latest && latest.state === "CLOSED" && Date.parse(latest.closedAt) >= docsCreated) return { state: "closed", pr: latest };
    return { state: "none" };
  }

  function wip(pr) {
    const marker = parseMarker(pr.body);
    if (!marker) return stale(pr, "held-Implementation PR (no code link was recorded)");

    // The parent's docs merged and its branch is gone: this PR now targets the default branch.
    if (pr.baseRefName.startsWith(WIP) && !heads.has(pr.baseRefName)) {
      gh(["pr", "edit", String(pr.number), "--base", defaultBranch]);
      pr = { ...pr, baseRefName: defaultBranch };
    }

    const code = codeState(marker, pr);
    if (code.state === "error") {
      out.errors.push(`${marker.codeRepo}: ${code.detail}`);
      if (say(pr, "no-code-access", `Could not look up ${marker.codeRepo}@${marker.codeBranch} (${code.detail}). Give the \`CODE_REPOS_TOKEN\` secret read access to that repository so this PR can follow its code.`)) flag(pr, `cannot read ${marker.codeRepo}`);
      return;
    }
    if (code.state === "open") {
      say(pr, "code-pr", `Waiting for the code PR: ${code.pr.url}. This docs PR merges when that one does.`);
      // An open code PR is what shows this is alive; a long-running feature
      // branch must not have its docs closed for being slow.
      out.waiting.push({ number: pr.number, codeRepo: marker.codeRepo, codeBranch: marker.codeBranch, codePr: code.pr.number });
      return;
    }
    if (code.state === "closed") {
      gh(["pr", "close", String(pr.number), "--delete-branch", "--comment", `${TAG("code-closed")}\nThe code PR ${code.pr.url} was closed without merging, so the Implementation held here never became true. Closing. (Decisions from the same sessions were already published.)`]);
      out.closedWithCode.push(pr.number);
      return;
    }
    if (code.state === "none") return stale(pr, `held-Implementation PR (no code PR found for ${marker.codeRepo}@${marker.codeBranch})`);

    // merged: docs merge into the branch their code merged into.
    if (pr.baseRefName !== defaultBranch) {
      const parent = prs.find((p) => p.headRefName === pr.baseRefName);
      const parentMarker = parent && parseMarker(parent.body);
      if (!parentMarker || parentMarker.codeBranch !== code.pr.baseRefName) {
        if (say(pr, "waiting-on-parent", `The code merged, but this docs PR is stacked on ${pr.baseRefName} and the code went into \`${code.pr.baseRefName}\`. Waiting for the parent docs PR.`)) flag(pr, "stacked on a docs PR that hasn't merged");
        out.waiting.push({ number: pr.number, codeRepo: marker.codeRepo, codeBranch: marker.codeBranch, parent: pr.baseRefName });
        return;
      }
    }
    if (pr.mergeable === "CONFLICTING") {
      gh(["pr", "edit", String(pr.number), "--add-label", "needs-rebase"]);
      if (say(pr, "conflict", `The code merged (${code.pr.url}) but this PR conflicts with \`${pr.baseRefName}\`: two branches edited the same Implementation lines. Resolve it here and it will merge on the next run.`)) flag(pr, "merge conflict");
      return;
    }
    if (pr.isDraft) gh(["pr", "ready", String(pr.number)]);
    let merged = gh(["pr", "merge", String(pr.number), "--squash", "--delete-branch"]);
    if (!merged.ok) merged = gh(["pr", "merge", String(pr.number), "--squash", "--auto", "--delete-branch"]);
    if (merged.ok) {
      out.merged.push(pr.number);
      return;
    }
    gh(["pr", "edit", String(pr.number), "--add-label", "ready-to-merge"]);
    if (say(pr, "merge-blocked", `The code merged (${code.pr.url}) but this PR could not be merged automatically (${merged.stderr.split("\n")[0] || "blocked"}). It is ready — merge it when the checks and reviews allow.`)) flag(pr, "merge blocked");
  }

  for (const pr of prs) {
    try {
      if (pr.headRefName.startsWith(WIP)) wip(pr);
      else stale(pr, "docs PR");
    } catch (error) {
      out.errors.push(`#${pr.number}: ${error.message}`);
    }
  }
  return out;
}

function report(out) {
  const line = (label, list) => (list.length ? `- ${label}: ${list.map((x) => (typeof x === "object" ? `#${x.number}` : `#${x}`)).join(", ")}\n` : "");
  return (
    "### Docs lifecycle\n" +
    line("merged with their code", out.merged) +
    line("closed with their code", out.closedWithCode) +
    line("waiting on a code PR", out.waiting) +
    line("reminded (stale)", out.reminded) +
    line("closed (stale)", out.closedStale) +
    line("need a human", out.needsHuman) +
    (out.errors.length ? `- problems: ${out.errors.join("; ")}\n` : "") +
    (Object.values(out).every((v) => v.length === 0) ? "Nothing to do.\n" : "")
  );
}

async function main() {
  const gh = realGh(process.env.GH_TOKEN);
  const codeGh = realGh(process.env.CODE_REPOS_TOKEN || process.env.GH_TOKEN);
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(".living-docs", "lifecycle.json"), "utf-8"));
  } catch {
    // defaults
  }
  const repoView = json(gh, ["repo", "view", "--json", "defaultBranchRef"], null);
  const defaultBranch = (repoView && repoView.defaultBranchRef && repoView.defaultBranchRef.name) || "main";

  const out = lifecycle({ gh, codeGh, config, defaultBranch });
  summary(report(out));
  out.errors.forEach((e) => annotate("warning", e));
  if (out.needsHuman.length) {
    const text = `Docs PRs that need a human:\n${out.needsHuman.map((n) => `• <${n.url}|#${n.number} ${n.title}> — ${n.why}`).join("\n")}`;
    const sent = await slack(text);
    if (!sent.sent && sent.reason !== "no webhook configured") annotate("warning", `Slack: ${sent.reason}`);
  }
}

if (require.main === module) main().catch((error) => {
  annotate("error", error.stack || error.message);
  process.exit(1);
});

module.exports = { lifecycle, parseMarker, report, WIP };
