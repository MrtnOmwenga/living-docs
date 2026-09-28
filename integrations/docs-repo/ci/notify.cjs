#!/usr/bin/env node
const fs = require("fs");
const { slack } = require("./_lib.cjs");

// Tells the team channel when a docs PR needs a human. Held-Implementation PRs
// are drafts that merge themselves, so they never ping; everything else is a
// decision (Context, a new module) or a problem (a capture that couldn't push).

function describe(pr) {
  const head = pr.head.ref;
  if (head.startsWith("docs/context-")) return "a Context change";
  if (head.startsWith("docs/new-domain-")) return "a new business domain";
  if (head.startsWith("docs/new-topic-")) return "a new standing topic";
  if (head.startsWith("docs/drift-")) return "a drift-audit correction";
  if (head.startsWith("docs/seed-")) return "the initial docs draft";
  if (head.startsWith("docs/capture-") || head.startsWith("docs/recovered-")) return "a capture that couldn't be pushed directly";
  return "a docs change";
}

function message(pr) {
  return `:memo: Docs PR ready for review — ${describe(pr)}: <${pr.html_url}|#${pr.number} ${pr.title}>`;
}

function shouldNotify(pr) {
  return !pr.draft && !pr.head.ref.startsWith("docs/wip/");
}

async function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf-8"));
  const pr = event.pull_request;
  if (!pr || !shouldNotify(pr)) return console.log("no notification for this PR");
  const sent = await slack(message(pr));
  console.log(sent.sent ? "notified Slack" : `not sent: ${sent.reason}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { describe, message, shouldNotify };
