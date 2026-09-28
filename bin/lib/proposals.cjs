const fs = require("fs");
const path = require("path");
const { git } = require("./git.cjs");
const { stateDir } = require("./state.cjs");
const { createModule } = require("./docs-modules.cjs");

// New domains and standing topics are a human decision. The extraction step
// only *proposes* them; this module turns proposals into reviewable PRs, and is
// careful not to turn one idea into five PRs or to keep re-asking after a "no".

const KINDS = { domain: "domain", "standing-topic": "topic" };
const FENCE = /```living-docs-proposals\s*\n([\s\S]*?)\n```/;
const BRANCH_PREFIX = "docs/new-";
const SUPPRESS_DAYS = 90;

// LLM output ends up in files and PR text, so it is flattened to one bounded
// line. (The slug is stricter still: it becomes a filename and a branch name.)
function oneLine(value, max) {
  return String(value || "").replace(/[`\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function moduleSlugs(docsDir) {
  const dir = path.join(docsDir, "modules");
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)));
}

// "notification" and "notifications" are the same idea.
function normalize(slug) {
  return slug.replace(/-/g, "").replace(/ies$/, "y").replace(/s$/, "");
}

function parseProposals(output, existingSlugs) {
  const match = (output || "").match(FENCE);
  if (!match) return [];
  let raw;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  return raw
    .filter(
      (p) =>
        p &&
        KINDS[p.kind] &&
        typeof p.slug === "string" &&
        /^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug) &&
        p.slug.length <= 50 &&
        !existingSlugs.has(p.slug) &&
        typeof p.title === "string" &&
        typeof p.why === "string"
    )
    .filter((p) => (seen.has(p.slug) ? false : seen.add(p.slug)))
    .map((p) => ({
      kind: p.kind,
      slug: p.slug,
      title: oneLine(p.title, 60),
      why: oneLine(p.why, 300),
      draft: oneLine(p.draft, 300),
    }));
}

const queueFile = () => path.join(stateDir(), "proposals.jsonl");

function readQueue() {
  try {
    return fs
      .readFileSync(queueFile(), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeQueue(entries) {
  fs.writeFileSync(queueFile(), entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
}

function enqueue(proposals, { repoUrl = null, meta = {} }) {
  if (proposals.length === 0) return;
  const at = new Date().toISOString();
  fs.appendFileSync(queueFile(), proposals.map((p) => JSON.stringify({ ...p, repoUrl, source: meta, at })).join("\n") + "\n");
}

function queuedCount(repoUrl) {
  return readQueue().filter((p) => p.repoUrl === repoUrl).length;
}

function sourcesText(items) {
  const lines = [...new Set(items.map((p) => `- ${p.source.repo}@${p.source.branch} (${p.source.sha}) — ${p.at.slice(0, 10)}`))];
  return lines.join("\n");
}

function proposalCommit(dir, base, items, { identity, trailers, log }) {
  const { kind, slug, title, why, draft } = items[0];
  const branch = `${BRANCH_PREFIX}${KINDS[kind]}-${slug}`;
  const description = draft || why;

  git(dir, ["checkout", "-b", branch, git(dir, ["rev-parse", "--verify", `origin/${base}`]).ok ? `origin/${base}` : base]);
  try {
    const { file } = createModule(dir, { slug, title, description: description.slice(0, 120), kind });
    if (draft) {
      const md = fs.readFileSync(file, "utf-8");
      // The reviewer sees the proposed use case in the PR — this is the moment
      // to correct it, which is why it is prefilled rather than left blank.
      fs.writeFileSync(file, md.replace(/^- Use case: $/m, `- Use case: ${draft}`).replace("_Not yet documented._\n\n", ""));
    }
  } catch (error) {
    log(`proposal ${slug}: could not create the module (${error.message}); dropped`);
    git(dir, ["checkout", "-f", base]);
    git(dir, ["branch", "-D", branch]);
    return false;
  }

  git(dir, ["add", "-A"]);
  const noun = kind === "domain" ? "business domain" : "standing topic";
  const body =
    `Proposed by automated capture. Adding a module is a human decision (documentation-policy: Direct push vs. PR).\n\n` +
    `**Why it doesn't fit an existing module:** ${why}\n\n` +
    (draft ? `**What would go in it:** ${draft}\n\n` : "") +
    `**Seen in:**\n${sourcesText(items)}\n\n` +
    `Merge to accept the module and its INDEX entry (edit the prefilled use case if needed). ` +
    `Close to reject — it will not be proposed again for ${SUPPRESS_DAYS} days.`;
  const committed = git(
    dir,
    ["commit", "-m", `docs: add ${noun} "${slug}" (needs review)`, "-m", body, "-m", trailers(items[0].source)],
    { identity }
  );
  git(dir, ["checkout", "-f", base]);
  if (!committed.ok) {
    git(dir, ["branch", "-D", branch]);
    log(`proposal ${slug}: could not commit (${committed.stderr.split("\n")[0]})`);
    return false;
  }
  log(`queued PR for new ${noun} "${slug}"`);
  return true;
}

// Runs inside the capture worker's lock, with the private clone on its base
// branch. `gh(dir, args)` and `trailers(meta)` come from the sync module.
function flushProposals({ repoUrl, dir, base, identity, log, gh, trailers }) {
  const all = readQueue();
  const mine = all.filter((p) => p.repoUrl === repoUrl);
  if (mine.length === 0) return;

  const remote = git(dir, ["ls-remote", "--heads", "origin", `${BRANCH_PREFIX}*`], { timeout: 20000 });
  if (!remote.ok) return; // offline: everything stays queued for the next run
  const remoteBranches = new Set(remote.stdout.split("\n").filter(Boolean).map((l) => l.split("\t")[1].replace("refs/heads/", "")));

  const existing = moduleSlugs(dir);
  const existingByNorm = new Map([...existing].map((s) => [normalize(s), s]));
  const openByNorm = new Map(
    [...remoteBranches].map((b) => [normalize(b.replace(new RegExp(`^${BRANCH_PREFIX}(domain|topic)-`), "")), b])
  );

  const groups = new Map();
  for (const p of mine) groups.set(`${p.kind}:${p.slug}`, [...(groups.get(`${p.kind}:${p.slug}`) || []), p]);

  const keep = [];
  for (const items of groups.values()) {
    const { kind, slug } = items[0];
    const branch = `${BRANCH_PREFIX}${KINDS[kind]}-${slug}`;
    const seenAgain = (number) => {
      if (!number) return;
      const s = items[items.length - 1];
      gh(dir, ["pr", "comment", String(number), "--body", `Seen again in ${s.source.repo}@${s.source.branch} (${s.source.sha}): ${s.why}`]);
    };

    if (existing.has(slug)) {
      log(`proposal ${slug}: a module with that name now exists; dropped`);
      continue;
    }
    if (existingByNorm.has(normalize(slug))) {
      log(`proposal ${slug}: too similar to existing module ${existingByNorm.get(normalize(slug))}; dropped`);
      continue;
    }
    if (git(dir, ["rev-parse", "--verify", branch]).ok) continue; // already waiting in the outbox

    const listed = gh(dir, ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,closedAt,labels"]);
    let prs = [];
    try {
      prs = listed.ok ? JSON.parse(listed.stdout || "[]") : [];
    } catch {
      prs = [];
    }
    const open = prs.find((p) => p.state === "OPEN");
    if (open || remoteBranches.has(branch)) {
      seenAgain(open && open.number);
      continue;
    }
    if (prs.some((p) => p.state === "MERGED")) continue;
    const cutoff = Date.now() - SUPPRESS_DAYS * 24 * 60 * 60 * 1000;
    // Closed by the stale-PR sweep means nobody looked, not that someone said no.
    const rejected = (p) => p.state === "CLOSED" && Date.parse(p.closedAt) > cutoff && !(p.labels || []).some((l) => l.name === "stale-closed");
    if (prs.some(rejected)) {
      log(`proposal ${slug}: rejected within the last ${SUPPRESS_DAYS} days; not proposing it again`);
      continue;
    }
    const twin = openByNorm.get(normalize(slug));
    if (twin) {
      log(`proposal ${slug}: an open proposal (${twin}) already covers it; dropped`);
      continue;
    }

    if (!proposalCommit(dir, base, items, { identity, trailers, log })) continue;
  }

  writeQueue([...all.filter((p) => p.repoUrl !== repoUrl), ...keep]);
}

module.exports = { parseProposals, moduleSlugs, enqueue, queuedCount, flushProposals, readQueue, normalize, BRANCH_PREFIX };
