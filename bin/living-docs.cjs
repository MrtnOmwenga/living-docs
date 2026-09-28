#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { STANDING_TOPICS, OPTIONAL_TOPICS, createModule } = require("./lib/docs-modules.cjs");
const { writeConfigIfMissing, resolveDocs } = require("./lib/docs-config.cjs");
const { policyPath } = require("./lib/policy-version.cjs");

const colors = { reset: "\x1b[0m", bright: "\x1b[1m", green: "\x1b[32m", blue: "\x1b[34m", yellow: "\x1b[33m", red: "\x1b[31m" };

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  title: (msg) => console.log(`\n${colors.bright}${msg}${colors.reset}\n`),
};

// ---------------------------------------------------------------------------
// Claude Code reads the docs through CLAUDE.md: an @import of the policy and of
// docs/INDEX.md, so every session starts knowing what's documented and the
// rules for writing it. The policy is copied into the code repo
// (.living-docs/documentation-policy.md) rather than imported from wherever the
// package happens to be installed, so a committed CLAUDE.md works on every
// machine that clones the repo.
// ---------------------------------------------------------------------------

const CLAUDE_MD_MARKER = "## Project docs (living-docs)";
const LOCAL_POLICY = path.join(".living-docs", "documentation-policy.md");

function writeLocalPolicy(cwd) {
  const target = path.join(cwd, LOCAL_POLICY);
  const policy = fs.readFileSync(policyPath());
  if (fs.existsSync(target) && fs.readFileSync(target).equals(policy)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, policy);
  return true;
}

function ensureClaudeMd(cwd) {
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  if (writeLocalPolicy(cwd)) log.success(`Wrote ${LOCAL_POLICY} (commit it)`);

  const docs = resolveDocs(cwd);
  const docsIndex = path.join(docs ? docs.docsDir : path.join(path.dirname(cwd), "docs"), "INDEX.md");
  const imports = [LOCAL_POLICY];
  if (fs.existsSync(docsIndex)) imports.push(path.relative(cwd, docsIndex));
  const block = `${CLAUDE_MD_MARKER}\n\n${imports.map((t) => `@${t}`).join("\n")}\n`;

  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, "utf-8");
    if (existing.includes(CLAUDE_MD_MARKER)) {
      log.info("CLAUDE.md already imports the project docs");
      return;
    }
    fs.writeFileSync(claudeMdPath, existing.replace(/\s*$/, "") + "\n\n" + block);
    log.success("Added the project docs import to CLAUDE.md");
  } else {
    fs.writeFileSync(claudeMdPath, block);
    log.success("Created CLAUDE.md importing the project docs");
  }
}

// ---------------------------------------------------------------------------
// docs/ bootstrap. Two kinds of module (see the policy):
//   - standing topics: fixed cross-cutting context (architecture, deployment,
//     ...), seeded from STANDING_TOPICS;
//   - business domains: proposed from src/ and confirmed by whoever runs init.
// For a brand-new docs folder the person running init IS the human approval,
// so confirmed domains are written directly. Adding a domain to an existing
// docs folder is the case that needs a PR.
// ---------------------------------------------------------------------------

const DOMAIN_BLOCKLIST = new Set([
  "common", "config", "shared", "utils", "filters", "guards",
  "decorators", "interfaces", "health", "app", "dto", "types",
  "constants", "lib", "middleware", "pipes", "interceptors", "test",
]);

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function proposeDomains(cwd) {
  const srcDir = path.join(cwd, "src");
  if (!fs.existsSync(srcDir)) return [];
  try {
    return fs
      .readdirSync(srcDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !DOMAIN_BLOCKLIST.has(d.name.toLowerCase()))
      .map((d) => ({ slug: slugify(d.name), description: `business domain (seeded from src/${d.name})` }))
      .filter((d) => d.slug);
  } catch {
    return [];
  }
}

async function promptPick(title, items, question) {
  log.title(title);
  items.forEach((item, i) => console.log(`  ${i + 1}. ${item.slug}${item.hint ? ` — ${item.hint}` : ""}`));
  const rl = require("readline/promises").createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\n${question} Numbers (e.g. 1 3), 'all', or Enter to skip: `)).trim();
  rl.close();
  if (!answer) return [];
  if (answer === "all") return items;
  return answer.split(/[\s,]+/).map((n) => items[Number(n) - 1]).filter(Boolean);
}

// --domains all | a,b,c  -> explicit, no prompt (also how CI/scripts run init)
// (no flag) + TTY        -> prompt
// (no flag) + no TTY     -> none; proposals are only printed
async function chooseDomains(proposed, domainsFlag) {
  if (domainsFlag === "all") return proposed;
  if (domainsFlag === "none") return [];
  if (domainsFlag) {
    return domainsFlag
      .split(",")
      .map(slugify)
      .filter(Boolean)
      .map((slug) => proposed.find((d) => d.slug === slug) || { slug, description: "business domain" });
  }
  if (proposed.length > 0 && process.stdin.isTTY) {
    return promptPick("Business domains proposed from src/ folder structure", proposed, "Create as business domains?");
  }
  return [];
}

// Same shape as chooseDomains, over OPTIONAL_TOPICS. Unknown names are
// rejected loudly rather than silently creating an unreviewed topic.
async function chooseOptionalTopics(topicsFlag) {
  if (topicsFlag === "all") return OPTIONAL_TOPICS;
  if (topicsFlag) {
    const wanted = topicsFlag.split(",").map((t) => t.trim()).filter(Boolean);
    const unknown = wanted.filter((w) => !OPTIONAL_TOPICS.some((t) => t.slug === w));
    if (unknown.length > 0) {
      throw new Error(`Unknown topic(s): ${unknown.join(", ")}. Optional topics: ${OPTIONAL_TOPICS.map((t) => t.slug).join(", ")}`);
    }
    return OPTIONAL_TOPICS.filter((t) => wanted.includes(t.slug));
  }
  if (process.stdin.isTTY) {
    return promptPick(
      "Optional standing topics (skip any that don't apply to this group)",
      OPTIONAL_TOPICS.map((t) => ({ ...t, hint: t.description })),
      "Add any of these?"
    );
  }
  return [];
}

async function ensureDocsBootstrap({ domainsFlag, topicsFlag }) {
  const cwd = process.cwd();
  const docsDir = path.join(path.dirname(cwd), "docs");
  const indexPath = path.join(docsDir, "INDEX.md");
  const proposed = proposeDomains(cwd);

  if (fs.existsSync(indexPath)) {
    log.info(`docs/ already exists at ${docsDir} — leaving as-is`);
    if (proposed.length > 0 || (domainsFlag && domainsFlag !== "none")) {
      log.info(
        "New domains for existing docs are proposed by the capture pipeline and reviewed as PRs. " +
          "Candidates from src/: " + (proposed.map((d) => d.slug).join(", ") || "none")
      );
    }
    return;
  }

  const domains = await chooseDomains(proposed, domainsFlag);
  const extraTopics = await chooseOptionalTopics(topicsFlag);

  fs.mkdirSync(path.join(docsDir, "modules"), { recursive: true });
  const projectName = path.basename(path.dirname(cwd));
  fs.writeFileSync(
    indexPath,
    `# ${projectName} — Project Docs\n\n` +
      `Living documentation: use case/constraints and current architecture per\n` +
      `module, plus a dated decision history. The documentation policy (imported\n` +
      "by each code repo's `CLAUDE.md` from `.living-docs/documentation-policy.md`)\n" +
      `says what belongs here and how each section gets updated.\n\n` +
      `## Standing topics\n\n` +
      `## Business domains\n\n_(none yet — new domains go through a PR, see the documentation policy)_\n`
  );

  [...STANDING_TOPICS, ...extraTopics].forEach((t) => createModule(docsDir, { ...t, kind: "standing-topic" }));
  domains.forEach((d) => createModule(docsDir, { ...d, kind: "domain" }));

  log.success(`Created docs/ at ${docsDir} (standing topics: ${[...STANDING_TOPICS, ...extraTopics].map((t) => t.slug).join(", ")})`);
  if (domains.length > 0) {
    log.success(`Seeded business domains: ${domains.map((d) => d.slug).join(", ")}`);
  } else if (proposed.length > 0) {
    log.info(`No domains seeded. Candidates from src/: ${proposed.map((d) => d.slug).join(", ")} — re-run with --domains <a,b,c|all> to seed them.`);
  }
}

// Hooks are global (~/.claude/settings.json) and call `living-docs` by name,
// so the CLI must be on PATH.
function ensureHooks() {
  try {
    const { installHooks } = require("./lib/claude-settings.cjs");
    const { changed, file } = installHooks();
    if (changed) log.success(`Registered docs hooks in ${file}`);
    else log.info("Docs hooks already registered in ~/.claude/settings.json");
  } catch (error) {
    log.warn(`Could not register hooks: ${error.message}`);
    return;
  }
  try {
    execSync("command -v living-docs", { stdio: "ignore", shell: "/bin/sh" });
  } catch {
    log.warn("`living-docs` is not on your PATH, so the hooks can't run. Install it globally: npm install -g living-docs");
  }
}

function writeCursorRule(cwd) {
  const docsRule = require("./lib/cursor-docs.cjs").writeCursorDocsRule(cwd);
  if (docsRule.status === "skipped") log.info("No project docs found: skipped .cursor/rules/project-docs.mdc (run init --target claude-code to create them, then init again)");
  else log.success(`${docsRule.status === "unchanged" ? "Already current" : docsRule.status === "created" ? "Wrote" : "Updated"} .cursor/rules/project-docs.mdc (commit it)`);
}

function publishDocsCommand({ repo, create, reviewers = [] }) {
  try {
    const result = require("./lib/docs-publish.cjs").publishDocs({ cwd: process.cwd(), repo, create, reviewers });
    if (result.alreadyPublished) {
      log.info(`Docs already published: ${result.url} (recorded in .living-docs/docs.json)`);
    } else {
      if (result.created) log.success(`Created ${result.created.name} (private)`);
      log.success(`Published ${result.docsDir} to ${result.url}`);
    }
    log.info("Commit the updated .living-docs/docs.json so everyone who clones this project finds the docs.");
  } catch (error) {
    log.error(error.message);
    process.exitCode = 1;
  }
}

function upgradeDocsCommand({ extraCodeRepos, reviewers }) {
  try {
    const result = require("./lib/docs-install.cjs").upgradeDocsRepo({ cwd: process.cwd(), extraCodeRepos, reviewers });
    if (result.upToDate) {
      log.info(`Docs automation is already up to date in ${result.repoUrl}`);
      return;
    }
    log.success(`Pushed ${result.pushedBranch} with ${result.changed.length} changed file(s)`);
    if (result.prUrl) log.success(`Review and merge: ${result.prUrl}`);
    else log.warn(result.note);
    if (result.codeowners === "no-owners") log.warn("No CODEOWNERS written: pass --reviewer <github-user> (or set reviewers in .living-docs/docs.json) so Context changes need a human owner.");
    log.info(`Code repos the drift audit will read: ${result.codeRepos.join(", ") || "(none)"}`);
    log.info("Add Actions secrets when ready: CODE_REPOS_TOKEN, ANTHROPIC_API_KEY, SLACK_WEBHOOK_URL (missing ones skip the step).");
  } catch (error) {
    log.error(error.message);
    process.exitCode = 1;
  }
}

function seedDocsCommand({ only, extraCodeDirs, dryRun }) {
  try {
    log.info("Reading the code to draft the empty modules (this can take a few minutes)...");
    const result = require("./lib/docs-seed.cjs").seedDocs({ cwd: process.cwd(), only, extraCodeDirs, dryRun, log: (m) => log.warn(m) });
    result.skipped.forEach((s) => log.info(`Left alone: ${s.slug} (${s.reason})`));
    if (result.drafts.length === 0) {
      log.info("Nothing to seed.");
      return;
    }
    result.drafts.forEach((d) => log.success(`Drafted ${d.slug}`));
    if (dryRun) {
      result.drafts.forEach((d) => console.log(`\n--- ${d.file} ---\n${d.after}`));
      log.info("Dry run: nothing was pushed.");
    } else if (result.prUrl) {
      log.success(`Review the drafts: ${result.prUrl}`);
    } else {
      log.warn(result.note || `Pushed ${result.branch}`);
    }
  } catch (error) {
    log.error(error.message);
    process.exitCode = 1;
  }
}

function enableMergeCaptureCommand() {
  try {
    const result = require("./lib/docs-install.cjs").enableMergeCapture(process.cwd());
    result.warnings.forEach((w) => log.warn(w));
    if (result.changed.length === 0) log.info(`${result.file} is already up to date`);
    else log.success(`Wrote ${result.file} (commit it). It needs DOCS_REPO_TOKEN and ANTHROPIC_API_KEY as Actions secrets in this repo.`);
  } catch (error) {
    log.error(error.message);
    process.exitCode = 1;
  }
}

function showHelp() {
  console.log(`
${colors.bright}living-docs${colors.reset}: project docs that keep themselves up to date

${colors.bright}USAGE${colors.reset}
  living-docs init [--target claude-code|cursor|both] [options]
                     Create the group's docs/ (if new), wire this code repo to
                     them, and register the Claude Code hooks
  living-docs docs publish (--repo <url> | --create) [--reviewer <a,b>]
                     Turn the local docs/ into a shared git repo and record it
                     in .living-docs/docs.json
  living-docs docs upgrade [--code-repo <owner/name>] [--reviewer <a,b>]
                     Install or update the docs repo's CI, lifecycle and drift
                     workflows, as a PR to review
  living-docs docs seed [--module <a,b>] [--code <dir>] [--dry-run]
                     Draft Context and Implementation for the empty modules
                     from the code and READMEs, as one PR to review
  living-docs docs enable-merge-capture
                     Add the workflow that files a merged PR's decisions into
                     the docs repo (for people without the hooks)
  living-docs doctor Check the hooks, docs repo, gh and recent captures

${colors.bright}INIT OPTIONS${colors.reset}
  --target <name>    claude-code (default): CLAUDE.md import, docs/ bootstrap, hooks
                     cursor: an always-on .cursor/rules/project-docs.mdc
                     both: all of the above
  --domains <list>   Business domains to seed when docs/ is created: "all" (every
                     folder in src/), "none", or a comma list (auth,billing).
                     Omitted: prompts in a terminal, otherwise none.
  --topics <list>    Optional standing topics on top of the defaults
                     (${STANDING_TOPICS.map((t) => t.slug).join(", ")}):
                     "all" or a comma list from ${OPTIONAL_TOPICS.map((t) => t.slug).join(", ")}.
  --docs-repo <url>  Publish the docs to this existing git repo
  --create-docs-repo Create <group>-docs on GitHub (private, same owner as this
                     repo's origin) and publish the docs to it
  --no-hooks         Don't register the hooks in ~/.claude/settings.json
`);
}

async function main() {
  const args = process.argv.slice(2);
  const values = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? args[i + 1].split(",") : [])).filter(Boolean);
  const flag = (name) => (args.indexOf(name) !== -1 ? args[args.indexOf(name) + 1] || null : null);

  // Invoked by Claude Code hooks, not by people: checked before --help so a
  // hook can never print usage text into a session.
  if (args[0] === "hook") {
    require("./lib/hooks.cjs").run(args[1]);
    return;
  }
  if (args[0] === "doctor") {
    process.exitCode = require("./lib/doctor.cjs").runDoctor(process.cwd());
    return;
  }
  if (args[0] === "docs") {
    switch (args[1]) {
      case "upgrade":
        return upgradeDocsCommand({ extraCodeRepos: values("--code-repo"), reviewers: values("--reviewer") });
      case "seed":
        return seedDocsCommand({ only: values("--module"), extraCodeDirs: values("--code"), dryRun: args.includes("--dry-run") });
      case "enable-merge-capture":
        return enableMergeCaptureCommand();
      case "publish":
        return publishDocsCommand({ repo: flag("--repo"), create: args.includes("--create"), reviewers: values("--reviewer") });
    }
  }
  if (args[0] !== "init" || args.includes("--help") || args.includes("-h")) {
    showHelp();
    if (args.length > 0 && !args.includes("--help") && !args.includes("-h")) {
      log.error(`Unknown command: ${args.join(" ")}`);
      process.exitCode = 1;
    }
    return;
  }

  const target = flag("--target") || "claude-code";
  if (!["cursor", "claude-code", "both"].includes(target)) {
    log.error(`Unknown target: ${target} (claude-code, cursor or both)`);
    process.exitCode = 1;
    return;
  }
  const cwd = process.cwd();

  if (target === "claude-code" || target === "both") {
    log.title("Setting up living docs for Claude Code");
    await ensureDocsBootstrap({ domainsFlag: flag("--domains"), topicsFlag: flag("--topics") });
    const { created, configPath } = writeConfigIfMissing(cwd);
    if (created) log.success(`Wrote ${path.relative(cwd, configPath)} (commit it)`);
    if (flag("--docs-repo") || args.includes("--create-docs-repo")) {
      publishDocsCommand({ repo: flag("--docs-repo"), create: args.includes("--create-docs-repo") });
    }
    ensureClaudeMd(cwd);
    if (!args.includes("--no-hooks")) ensureHooks();
  }
  if (target === "cursor" || target === "both") writeCursorRule(cwd);
}

main().catch((error) => {
  log.error(error.message);
  process.exit(1);
});
