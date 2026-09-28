const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { git, isGitRepo, withLock, parseOrigin } = require("./git.cjs");
const { stateDir } = require("./state.cjs");
const lint = require("./docs-lint.cjs");
const { parseProposals, moduleSlugs, enqueue, flushProposals } = require("./proposals.cjs");
const { compareVersions } = require("./policy-version.cjs");

// How the capture worker gets a change into the shared docs repo.
//
// The worker never touches the developer's own docs/ checkout: it works in a
// private clone under ~/.local/state/living-docs/clones/, so a half-finished run, an
// uncommitted human edit or a concurrent session can't collide with it. The
// developer's checkout is fast-forwarded afterwards (and on session start).
//
//   pull -> extract -> lint (revert bad files) -> split Context from the rest
//   -> commit + push the rest to main (retry against fresh state on conflict)
//   -> Context edits and anything that couldn't be pushed go to docs/* branches
//   -> publish those branches as PRs
//
// Anything that can't ship yet (offline, gh missing) stays as a local commit
// or docs/* branch and is retried at the start of the next run, so a capture
// is never silently dropped.
//
// Held Implementation. What a module's Implementation says is only true once
// the code is on the default branch, so edits captured from an unmerged code
// branch wait on a docs/wip/<repo>/<branch> branch (one per code branch, opened
// as a draft PR) instead of going to main. Decision History entries and Context
// proposals are unaffected: a decision was made whether or not the code lands.
// The docs-repo lifecycle workflow merges the wip PR when the code PR merges
// (see integrations/docs-repo/). A branch cut from another code branch stacks
// its wip on the parent's, so their docs land in the same order as the code.

const MAX_ATTEMPTS = 3;
const OUTBOX_PREFIX = "docs/";
const WIP_PREFIX = "docs/wip/";
const isWip = (branch) => branch.startsWith(WIP_PREFIX);

function stamp() {
  return (
    new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) +
    "-" +
    crypto.randomBytes(2).toString("hex")
  );
}

function cloneLocation(repoUrl) {
  const id = crypto.createHash("sha1").update(repoUrl).digest("hex").slice(0, 12);
  const root = path.join(stateDir(), "clones");
  fs.mkdirSync(root, { recursive: true });
  return { dir: path.join(root, id), lock: path.join(root, `${id}.lock`) };
}

function defaultBranch(dir) {
  const read = () => git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  let ref = read();
  if (!ref.ok) {
    git(dir, ["remote", "set-head", "origin", "-a"]);
    ref = read();
  }
  return ref.ok && ref.stdout.startsWith("origin/") ? ref.stdout.slice("origin/".length) : "main";
}

// Commits are attributed to the developer whose session produced them, but
// named so history shows they were written by the automation.
function commitIdentity(cwd) {
  const name = git(cwd, ["config", "user.name"]).stdout || os.userInfo().username;
  const email = git(cwd, ["config", "user.email"]).stdout || `${os.userInfo().username}@localhost`;
  return { name: `Claude (via ${name})`, email };
}

// `branch` is the branch the discussion happened on, which after a session
// that hopped between branches is not necessarily the one checked out now.
function sourceMeta(cwd, branch = null) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const head = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "unknown";
  const name = branch || head;
  const tip = [`refs/heads/${name}`, `refs/remotes/origin/${name}`, "HEAD"]
    .map((ref) => git(cwd, ["rev-parse", "--short", "--verify", "--quiet", ref]))
    .find((r) => r.ok);
  return {
    repo: path.basename(top.ok ? top.stdout : cwd),
    branch: name,
    sha: tip ? tip.stdout : "unknown",
  };
}

function trailers(meta) {
  return [
    `Source-Repo: ${meta.repo}`,
    `Source-Branch: ${meta.branch}`,
    `Source-Commit: ${meta.sha}`,
    "Captured-By: living-docs hook capture",
  ].join("\n");
}

function gh(dir, args) {
  const result = spawnSync("gh", args, { cwd: dir, encoding: "utf-8", timeout: 60000 });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    missing: result.error && result.error.code === "ENOENT",
  };
}

// Pushes a wip branch's local commits. A non-fast-forward means another
// developer captured onto the same code branch; their commits are merged in
// rather than overwritten (force is never used).
function pushWip(dir, branch, log) {
  const ahead = git(dir, ["rev-list", "--count", `origin/${branch}..${branch}`]);
  if (!ahead.ok || Number(ahead.stdout) === 0) return true;
  if (git(dir, ["push", "origin", branch], { timeout: 60000 }).ok) return true;
  const current = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
  git(dir, ["checkout", branch]);
  const merged = git(dir, ["merge", "--no-edit", `origin/${branch}`], { identity: { name: "Claude", email: "noreply@anthropic.com" } });
  if (!merged.ok) git(dir, ["merge", "--abort"]);
  git(dir, ["checkout", current]);
  if (merged.ok && git(dir, ["push", "origin", branch], { timeout: 60000 }).ok) return true;
  log(`outbox: could not push ${branch}; keeping it for the next run`);
  return false;
}

// Pushes every local docs/* branch that isn't shipped yet and opens its PR.
// The branch's tip commit message is the PR title and body, so a branch is
// self-describing whether it was just created or is being retried later.
function publishOutbox(dir, log, { reviewers = [] } = {}) {
  const branches = git(dir, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${OUTBOX_PREFIX}`]);
  if (!branches.ok || !branches.stdout) return;

  for (const branch of branches.stdout.split("\n")) {
    const wip = isWip(branch);
    const onRemote = git(dir, ["ls-remote", "--heads", "origin", branch], { timeout: 20000 });
    if (!onRemote.ok) {
      log(`outbox: remote unreachable, keeping ${branch} for the next run`);
      return;
    }
    if (!onRemote.stdout) {
      const pushed = git(dir, ["push", "-u", "origin", branch], { timeout: 60000 });
      if (!pushed.ok) {
        log(`outbox: push of ${branch} failed (${pushed.stderr.split("\n")[0]}); keeping it`);
        continue;
      }
    } else if (wip && !pushWip(dir, branch, log)) {
      continue; // a wip branch keeps growing, so unpushed commits must not be dropped
    }

    // A wip branch name is reused by later work on the same code branch, so
    // only an *open* PR means it is already handled; proposals are one-shot.
    const existing = gh(dir, ["pr", "list", "--head", branch, "--state", wip ? "open" : "all", "--json", "number"]);
    if (existing.missing) {
      log(`outbox: ${branch} is pushed but \`gh\` is not installed — open the PR manually`);
      continue;
    }
    if (existing.ok && existing.stdout && existing.stdout !== "[]") {
      git(dir, ["branch", "-D", branch]);
      continue;
    }

    const message = git(dir, ["log", "-1", "--format=%s%n%n%b", branch]).raw;
    const [title, ...rest] = message.split("\n");
    let base = defaultBranch(dir);
    // A stacked wip PR targets its parent's wip branch until that one merges.
    const stackedOn = (message.match(/^Docs-Base: (\S+)$/m) || [])[1];
    if (wip && stackedOn && git(dir, ["ls-remote", "--heads", "origin", stackedOn]).stdout) base = stackedOn;
    const create = (extra) =>
      gh(dir, [
        "pr", "create", "--base", base, "--head", branch, "--title", title, "--body", rest.join("\n").trim(),
        ...(wip ? ["--draft"] : []),
        ...extra,
      ]);
    let created = reviewers.length ? create(["--reviewer", reviewers.join(",")]) : create([]);
    if (!created.ok && reviewers.length) {
      // A stale or misspelled reviewer must not stop the PR from opening.
      log(`outbox: gh rejected reviewers (${created.stderr.split("\n")[0]}); opening ${branch} without them`);
      created = create([]);
    }
    if (created.ok) {
      log(`opened PR for ${branch}: ${created.stdout.split("\n").pop()}`);
      git(dir, ["branch", "-D", branch]);
    } else {
      log(`outbox: could not open PR for ${branch} (${created.stderr.split("\n")[0]}); keeping it`);
    }
  }
}

function prepareClone(repoUrl, dir, log, reviewers) {
  if (!fs.existsSync(path.join(dir, ".git"))) {
    const cloned = git(path.dirname(dir), ["clone", repoUrl, dir], { timeout: 60000 });
    if (!cloned.ok) {
      log(`clone of ${repoUrl} failed: ${cloned.stderr.split("\n")[0]}`);
      return null;
    }
  }

  // Private clone: anything uncommitted is leftover output of a run that died
  // before linting it, never a human's work, so discarding it is safe.
  git(dir, ["reset", "--hard", "HEAD"]);
  git(dir, ["clean", "-fd"]);

  const base = defaultBranch(dir);
  git(dir, ["checkout", base]);

  // --prune: a merged wip branch is deleted on the remote, and a stale
  // remote-tracking ref would make it look like a live parent to stack on.
  const fetched = git(dir, ["fetch", "--prune", "origin"], { timeout: 30000 });
  if (!fetched.ok) {
    log("offline: working from the last fetched state");
    return { base, online: false };
  }

  const pulled = git(dir, ["pull", "--rebase", "origin", base], { timeout: 30000 });
  if (!pulled.ok) {
    git(dir, ["rebase", "--abort"]);
    const rescue = `${OUTBOX_PREFIX}recovered-${stamp()}`;
    git(dir, ["branch", rescue, "HEAD"]);
    git(dir, ["reset", "--hard", `origin/${base}`]);
    log(`unpushed commits no longer rebase cleanly; kept them on ${rescue} for a PR`);
  }

  const ahead = git(dir, ["rev-list", "--count", `origin/${base}..HEAD`]);
  if (ahead.ok && Number(ahead.stdout) > 0) {
    const pushed = git(dir, ["push", "origin", `HEAD:${base}`], { timeout: 60000 });
    log(pushed.ok ? "pushed commits left over from an earlier run" : "leftover commits still can't be pushed");
  }

  publishOutbox(dir, log, { reviewers });
  return { base, online: true };
}

// Reverts whatever the policy forbids and separates the Context edits (which
// go to a PR) from everything else (which is pushed directly). Decided from
// the actual file diff, never from what the extraction step reported.
//
// In `held` mode the working tree is a wip branch: Decision History additions
// are lifted out (returned as `decisionAdds`, to be applied to main as data)
// and the file keeps its old Decision History, so what remains is exactly the
// change that has to wait for the code.
function lintAndSplit(dir, log, meta, { held = false } = {}) {
  const untracked = git(dir, ["ls-files", "--others", "--exclude-standard"]);
  untracked.stdout.split("\n").filter(Boolean).forEach((file) => {
    fs.rmSync(path.join(dir, file), { recursive: true, force: true });
    log(`dropped ${file}: new files are proposed, not written (see policy)`);
  });

  const changes = git(dir, ["-c", "core.quotepath=off", "diff", "--name-status", "HEAD"]);
  const contextChanges = [];
  const decisionAdds = [];
  let mainChanged = false;

  for (const line of changes.stdout.split("\n").filter(Boolean)) {
    const [code, file] = line.split("\t");
    const isModule = /^modules\/[^/]+\.md$/.test(file || "");

    if (code !== "M" || !isModule) {
      git(dir, ["checkout", "HEAD", "--", file]);
      log(`reverted ${file}: only edits to existing modules/*.md are allowed`);
      continue;
    }

    const slug = path.basename(file, ".md");
    const before = git(dir, ["show", `HEAD:${file}`]).raw;
    let after = fs.readFileSync(path.join(dir, file), "utf-8");

    const violations = lint.lintChange({ slug, before, after });
    if (violations.length > 0) {
      git(dir, ["checkout", "HEAD", "--", file]);
      violations.forEach((v) => log(`reverted ${file}: ${v}`));
      continue;
    }

    // Provenance is stamped mechanically so the extraction step can't forget it.
    const tag = `${meta.repo}@${meta.branch} ${meta.sha}`;
    let tagged = lint.tagNewEntries(before, after, "Decision History", tag);
    tagged = lint.tagNewEntries(before, tagged, "Issues", tag);
    if (tagged !== after) {
      after = tagged;
      fs.writeFileSync(path.join(dir, file), after);
    }

    if (lint.contextChanged(before, after)) {
      const oldContext = lint.getSection(before, "Context");
      const mainVersion =
        oldContext === null ? lint.removeSection(after, "Context") : lint.replaceSection(after, "Context", oldContext);
      fs.writeFileSync(path.join(dir, file), mainVersion);
      contextChanges.push({ file, slug, context: lint.getSection(after, "Context") });
    }

    if (held) {
      const current = fs.readFileSync(path.join(dir, file), "utf-8");
      const was = lint.getSection(before, "Decision History");
      const now = lint.getSection(current, "Decision History");
      if (was !== null && now !== null) {
        const lines = lint.addedLines(was, now);
        if (lines.length > 0) decisionAdds.push({ file, slug, lines });
        fs.writeFileSync(path.join(dir, file), lint.replaceSection(current, "Decision History", was));
      }
    }

    if (!git(dir, ["diff", "--quiet", "HEAD", "--", file]).ok) mainChanged = true;
  }

  return { mainChanged, contextChanges, decisionAdds };
}

function commitMain(dir, meta, identity) {
  git(dir, ["add", "-A"]);
  const files = git(dir, ["diff", "--cached", "--name-only"]).stdout.split("\n").filter(Boolean);
  const modules = files.map((f) => path.basename(f, ".md")).join(", ");
  const commit = git(
    dir,
    ["commit", "-m", `docs: capture from ${meta.repo}@${meta.branch}`, "-m", `Modules: ${modules}`, "-m", trailers(meta)],
    { identity }
  );
  return commit.ok;
}

function queueContextPrs(dir, base, changes, meta, identity, log) {
  for (const change of changes) {
    const branch = `${OUTBOX_PREFIX}context-${change.slug}-${stamp()}`;
    git(dir, ["checkout", "-b", branch]);
    const file = path.join(dir, change.file);
    fs.writeFileSync(file, lint.setSection(fs.readFileSync(file, "utf-8"), "Context", change.context));
    git(dir, ["add", "-A"]);
    const body =
      `Proposed by automated capture from ${meta.repo}@${meta.branch} (${meta.sha}).\n\n` +
      "Context states what a module is for and what constrains it, so changes to it always need review " +
      "(documentation-policy: Direct push vs. PR). Nothing else in this capture is in this PR.";
    const committed = git(
      dir,
      ["commit", "-m", `docs: Context change for ${change.slug} (needs review)`, "-m", body, "-m", trailers(meta)],
      { identity }
    );
    log(committed.ok ? `queued Context PR for ${change.slug}` : `could not commit Context change for ${change.slug}`);
    git(dir, ["checkout", base]);
  }
}

function pushBase(dir, base) {
  return git(dir, ["push", "origin", `HEAD:${base}`], { timeout: 60000 });
}

// ---- direct path: the code is on the default branch (or can't be tracked) ----

// Extracts, lints and pushes to the docs repo's default branch. Returns
// { status, output, contextChanges }; Context edits are for the caller to queue.
function captureDirect({ dir, base, extract, segment, meta, identity, log }) {
  let output = "";
  let status = "no-changes";
  let contextChanges = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      git(dir, ["fetch", "origin"]);
      git(dir, ["reset", "--hard", `origin/${base}`]);
    }

    const extracted = extract(dir, segment);
    if (extracted.error) {
      log(`extraction failed: ${extracted.error}`);
      git(dir, ["reset", "--hard", "HEAD"]);
      return { status: "extract-failed", output: "", contextChanges: [] };
    }
    output = extracted.output;

    const split = lintAndSplit(dir, log, meta);
    contextChanges = split.contextChanges;
    if (!split.mainChanged) {
      status = contextChanges.length ? "context-only" : "no-changes";
      break;
    }
    if (!commitMain(dir, meta, identity)) {
      status = "commit-failed";
      break;
    }

    if (pushBase(dir, base).ok) {
      status = "pushed";
      break;
    }
    if (!git(dir, ["fetch", "origin"], { timeout: 30000 }).ok) {
      status = "deferred"; // offline: commit stays local, pushed next run
      break;
    }
    if (git(dir, ["pull", "--rebase", "origin", base], { timeout: 30000 }).ok) {
      if (pushBase(dir, base).ok) {
        status = "pushed";
        break;
      }
      // Rebased fine but still refused: protected branch or similar.
      git(dir, ["branch", `${OUTBOX_PREFIX}capture-${stamp()}`, "HEAD"]);
      git(dir, ["reset", "--hard", `origin/${base}`]);
      status = "queued-as-pr";
      break;
    }
    // Real conflict with someone else's change to the same lines. Don't
    // text-merge: throw this attempt away and extract again on fresh state.
    git(dir, ["rebase", "--abort"]);
    log(`push conflict on attempt ${attempt}; re-extracting against the latest docs`);
    status = "conflict";
  }

  if (status === "conflict") {
    // Out of attempts: keep the work as a PR so a human resolves it.
    git(dir, ["branch", `${OUTBOX_PREFIX}capture-${stamp()}`, "HEAD"]);
    git(dir, ["fetch", "origin"]);
    git(dir, ["reset", "--hard", `origin/${base}`]);
    status = "queued-as-pr";
  }
  return { status, output, contextChanges };
}

// ---- held path: the code is on an unmerged branch ----

// Filesystem- and ref-safe name for a code branch (`feat/x` -> `feat--x`).
function slugPart(value) {
  return (
    String(value)
      .replace(/\//g, "--")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 80) || "x"
  );
}

const wipBranchName = (repo, codeBranch) => `${WIP_PREFIX}${slugPart(repo)}/${slugPart(codeBranch)}`;

function codeDefaultBranch(cwd) {
  const ref = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return ref.ok && ref.stdout.startsWith("origin/") ? ref.stdout.slice("origin/".length) : null;
}

// True when a merged PR for this branch already contains everything on it. A
// branch cut from main that has no commits yet must NOT count as merged (its
// tip is an ancestor of main), which is why this looks at PRs, not ancestry.
function alreadyMerged(cwd, codeRepo, branch) {
  const tip = git(cwd, ["rev-parse", `refs/heads/${branch}`]);
  if (!tip.ok) return false;
  const listed = gh(cwd, ["pr", "list", "--repo", codeRepo, "--head", branch, "--state", "merged", "--json", "headRefOid"]);
  if (!listed.ok) return false;
  try {
    return JSON.parse(listed.stdout || "[]").some((pr) => pr.headRefOid === tip.stdout);
  } catch {
    return false;
  }
}

// Decides whether this segment's Implementation edits are held, and if so
// where they wait. Returns null for "push to the default branch as before":
// no GitHub origin to track a merge against, already on the default branch, or
// the code is already merged.
function holdPlan({ cwd, dir, meta, hold }) {
  if (!hold) return null;
  const codeRepo = parseOrigin(originOf(cwd));
  if (!codeRepo) return null;
  const codeName = `${codeRepo.owner}/${codeRepo.repo}`;

  const integration = codeDefaultBranch(cwd);
  if (meta.branch === (integration || (["main", "master"].includes(meta.branch) ? meta.branch : null))) return null;
  if (alreadyMerged(cwd, codeName, meta.branch)) return null;

  const detached = meta.branch === "HEAD";
  const codeBranch = detached ? `detached-${meta.sha}` : meta.branch;
  const wip = wipBranchName(meta.repo, codeBranch);

  // Stack on the parent's wip when this branch was cut from a code branch that
  // has held docs of its own; otherwise on the default branch.
  const wipRefs = git(dir, ["for-each-ref", "--format=%(refname:short)", `refs/remotes/origin/${WIP_PREFIX}`, `refs/heads/${WIP_PREFIX}`]);
  const known = new Set(wipRefs.stdout.split("\n").filter(Boolean).map((r) => r.replace(/^origin\//, "")));
  let parent = null;
  if (!detached) {
    const refs = git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"]).stdout.split("\n");
    const names = [...new Set(refs.map((r) => r.replace(/^origin\//, "")).filter((n) => n && n !== "HEAD" && n !== "origin" && n !== meta.branch && n !== integration))];
    const tip = `refs/heads/${meta.branch}`;
    const trunk = [`refs/remotes/origin/${integration || "main"}`, "refs/heads/main", "refs/heads/master"].find(
      (ref) => git(cwd, ["rev-parse", "--verify", "--quiet", ref]).ok
    );
    for (const name of names) {
      const wipName = wipBranchName(meta.repo, name);
      if (!known.has(wipName)) continue;
      const ref = git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).ok ? `refs/heads/${name}` : `refs/remotes/origin/${name}`;
      // A branch with no commits of its own sits on the default branch's tip and
      // is an "ancestor" of every sibling; only real work makes a parent.
      if (trunk && git(cwd, ["merge-base", "--is-ancestor", ref, trunk]).ok) continue;
      if (!git(cwd, ["merge-base", "--is-ancestor", ref, tip]).ok) continue;
      const distance = Number(git(cwd, ["rev-list", "--count", `${ref}..${tip}`]).stdout);
      if (!parent || distance < parent.distance) parent = { name, wip: wipName, distance };
    }
  }

  return {
    wip,
    codeRepo: codeName,
    codeBranch,
    codeDefault: integration || "main",
    parentCode: parent && parent.name,
    parentWip: parent && parent.wip,
  };
}

// Puts the private clone on the wip branch, creating it (from the parent's wip,
// else the default branch) or bringing an existing one up to date. Conflicts
// are left for a human in the PR rather than resolved here.
function ensureWip(dir, plan, base, identity, log) {
  const has = (ref) => git(dir, ["rev-parse", "--verify", "--quiet", ref]).ok;
  const remote = `refs/remotes/origin/${plan.wip}`;
  const baseRef = has(`refs/remotes/origin/${base}`) ? `origin/${base}` : base;
  let created = false;

  if (has(`refs/heads/${plan.wip}`)) {
    git(dir, ["checkout", plan.wip]);
  } else if (has(remote)) {
    git(dir, ["checkout", "-b", plan.wip, `origin/${plan.wip}`]);
  } else {
    const parentRef = plan.parentWip && has(`refs/remotes/origin/${plan.parentWip}`) ? `origin/${plan.parentWip}` : null;
    git(dir, ["checkout", "-b", plan.wip, parentRef || baseRef]);
    created = true;
  }
  const start = git(dir, ["rev-parse", "HEAD"]).stdout;

  if (!created) {
    const upstreams = [has(remote) ? `origin/${plan.wip}` : null, plan.parentWip && has(`refs/remotes/origin/${plan.parentWip}`) ? `origin/${plan.parentWip}` : null, baseRef];
    for (const ref of upstreams.filter(Boolean)) {
      const merged = git(dir, ["merge", "--no-edit", ref], { identity });
      if (!merged.ok) {
        git(dir, ["merge", "--abort"]);
        log(`${plan.wip}: conflicts with ${ref}; resolve it in the PR (new captures still land on the branch)`);
      }
    }
  }
  return { created, start };
}

function wipMessage(meta, plan) {
  const marker = [
    "<!-- living-docs-wip",
    `code-repo: ${plan.codeRepo}`,
    `code-branch: ${plan.codeBranch}`,
    `code-default: ${plan.codeDefault}`,
    plan.parentCode ? `parent-code-branch: ${plan.parentCode}` : null,
    "-->",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    `docs: ${meta.repo}@${plan.codeBranch} (held until the code merges)`,
    `Implementation edits captured from ${meta.repo}@${plan.codeBranch} (${meta.sha}). They describe code that is not on ` +
      `${plan.codeDefault} yet, so they wait here instead of main. This PR is merged automatically when the code PR ` +
      `merges, and closed if that PR is closed unmerged.` +
      (plan.parentWip ? `\n\nStacked on ${plan.parentWip}: the code branch was cut from ${plan.parentCode}, so its docs land after that branch's.` : "") +
      `\n\n${marker}`,
    [plan.parentWip ? `Docs-Base: ${plan.parentWip}` : null, trailers(meta)].filter(Boolean).join("\n"),
  ];
}

// Decision History entries are data (lines to append), not a diff, so
// applying them to main is a loop that re-reads main each time instead of a
// merge that could conflict with a teammate's concurrent entry.
function applyDecisions(dir, base, adds, meta, identity, log) {
  if (adds.length === 0) return "no-changes";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    git(dir, ["checkout", base]);
    if (git(dir, ["fetch", "origin"], { timeout: 30000 }).ok) git(dir, ["reset", "--hard", `origin/${base}`]);

    for (const { file, lines } of adds) {
      const target = path.join(dir, file);
      if (!fs.existsSync(target)) continue;
      const before = fs.readFileSync(target, "utf-8");
      const after = lint.appendToSection(before, "Decision History", lines);
      if (after !== before && lint.lintChange({ slug: path.basename(file, ".md"), before, after }).length === 0) {
        fs.writeFileSync(target, after);
      }
    }
    if (git(dir, ["diff", "--quiet", "HEAD"]).ok) return "no-changes";
    if (!commitMain(dir, meta, identity)) return "commit-failed";
    if (pushBase(dir, base).ok) return "pushed";
    if (!git(dir, ["fetch", "origin"], { timeout: 30000 }).ok) return "deferred";
    log(`decision push raced with another change (attempt ${attempt}); retrying on the latest docs`);
  }
  git(dir, ["branch", `${OUTBOX_PREFIX}capture-${stamp()}`, "HEAD"]);
  git(dir, ["fetch", "origin"]);
  git(dir, ["reset", "--hard", `origin/${base}`]);
  return "queued-as-pr";
}

function captureHeld({ dir, base, extract, segment, meta, plan, identity, log }) {
  const { created, start } = ensureWip(dir, plan, base, identity, log);
  const abandon = () => {
    git(dir, ["reset", "--hard", "HEAD"]);
    git(dir, ["clean", "-fd"]);
    git(dir, ["checkout", base]);
    // A branch we just made and never committed to would only clutter the outbox.
    if (created && git(dir, ["rev-parse", plan.wip]).stdout === start) git(dir, ["branch", "-D", plan.wip]);
  };

  const extracted = extract(dir, segment);
  if (extracted.error) {
    log(`extraction failed: ${extracted.error}`);
    abandon();
    return { status: "extract-failed", output: "", contextChanges: [] };
  }

  const split = lintAndSplit(dir, log, meta, { held: true });
  let status = "no-changes";
  if (split.mainChanged) {
    git(dir, ["add", "-A"]);
    const [subject, ...body] = wipMessage(meta, plan);
    const committed = git(dir, ["commit", "-m", subject, ...body.flatMap((b) => ["-m", b])], { identity });
    if (committed.ok) {
      status = "held";
      if (git(dir, ["push", "-u", "origin", plan.wip], { timeout: 60000 }).ok) log(`held Implementation edits on ${plan.wip} until ${plan.codeRepo}@${plan.codeBranch} merges`);
      else log(`held edits committed to ${plan.wip}; will push on the next run`);
    } else {
      log(`could not commit held edits to ${plan.wip}: ${committed.stderr.split("\n")[0]}`);
      status = "commit-failed";
    }
  }
  abandon();

  if (status !== "commit-failed") {
    const decided = applyDecisions(dir, base, split.decisionAdds, meta, identity, log);
    if (decided === "pushed" || (status === "no-changes" && decided !== "no-changes")) status = decided;
  }
  return { status, output: extracted.output, contextChanges: split.contextChanges };
}

// Runs one capture against the shared docs repo. `extract(dir, segment)` runs
// the model inside the clone and returns { output } or { error }. `segments`
// are the branch-separated parts of the discussion ({ branch, ... }); without
// them it is one segment on whatever branch is checked out.
function captureIntoRepo({ repoUrl, cwd, extract, log, reviewers = [], segments, hold = true }) {
  const { dir, lock } = cloneLocation(repoUrl);
  const locked = withLock(lock, () => {
    const ready = prepareClone(repoUrl, dir, log, reviewers);
    if (!ready) return { status: "clone-failed" };
    const { base } = ready;

    // An older tool writing under a newer policy would produce edits the newer
    // rules reject, so it stops (and is retried once upgraded); a newer tool
    // writing into docs that haven't been upgraded proceeds and says so.
    const policy = compareVersions(dir);
    if (policy.relation === "older") {
      log(`policy outdated: these docs follow policy v${policy.docs} but this tool has v${policy.tool} — upgrade living-docs; skipping this capture`);
      return { status: "policy-outdated" };
    }
    if (policy.relation === "newer") {
      log(`note: the docs repo records policy v${policy.docs}, this tool has v${policy.tool} — run \`living-docs docs upgrade\` to bring the repo up to date`);
    }

    const identity = commitIdentity(cwd);
    const parts = segments && segments.length ? segments : [{ branch: null }];
    const results = [];

    for (const segment of parts) {
      const meta = sourceMeta(cwd, segment.branch);
      const plan = holdPlan({ cwd, dir, meta, hold });
      const result = plan
        ? captureHeld({ dir, base, extract, segment, meta, plan, identity, log })
        : captureDirect({ dir, base, extract, segment, meta, identity, log });
      results.push(result.status);

      queueContextPrs(dir, base, result.contextChanges, meta, identity, log);

      // New modules are proposed, never written: queue what the model proposed,
      // then turn the queue into (deduplicated) PR branches.
      enqueue(parseProposals(result.output, moduleSlugs(dir)), { repoUrl, meta });
    }

    flushProposals({ repoUrl, dir, base, identity, log, gh, trailers });
    publishOutbox(dir, log, { reviewers });

    const retryable = results.find((r) => ["extract-failed", "commit-failed"].includes(r));
    const status = retryable || [...results].reverse().find((r) => r !== "no-changes") || "no-changes";
    return { status, statuses: results };
  });

  if (!locked.locked) {
    log("another capture holds the lock for too long; skipping this one");
    return { status: "lock-timeout" };
  }
  return locked.value;
}

// Fast-forwards the developer's own docs checkout. Never merges or discards:
// if they have local edits or have diverged, it leaves things alone.
function originOf(dir) {
  if (!isGitRepo(dir)) return null;
  const origin = git(dir, ["remote", "get-url", "origin"]);
  return origin.ok ? origin.stdout : null;
}

function pullDocs(docsDir, timeout = 8000) {
  if (!isGitRepo(docsDir)) return { ok: false, reason: "not-a-git-repo" };
  const pulled = git(docsDir, ["pull", "--ff-only"], { timeout });
  return { ok: pulled.ok, reason: pulled.ok ? "" : pulled.stderr.split("\n")[0] };
}

// SessionStart: make sure the docs exist locally and are current. Returns
// { cloned } so the caller can hand the INDEX to a session that started before
// the docs existed (CLAUDE.md's @import had nothing to load).
function ensureLocalDocs({ docsDir, repoUrl }) {
  if (!fs.existsSync(docsDir)) {
    if (!repoUrl) return { ok: false, cloned: false, reason: "docs folder missing and no docsRepo configured" };
    fs.mkdirSync(path.dirname(docsDir), { recursive: true });
    const cloned = git(path.dirname(docsDir), ["clone", repoUrl, docsDir], { timeout: 60000 });
    return { ok: cloned.ok, cloned: cloned.ok, reason: cloned.ok ? "" : cloned.stderr.split("\n")[0] };
  }
  const pulled = pullDocs(docsDir);
  return { ok: pulled.ok || pulled.reason === "not-a-git-repo", cloned: false, reason: pulled.reason };
}

module.exports = { publishOutbox, WIP_PREFIX, wipBranchName, sourceMeta, originOf, captureIntoRepo, ensureLocalDocs, pullDocs, publishOutbox, cloneLocation, defaultBranch };
