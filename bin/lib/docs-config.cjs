const fs = require("fs");
const path = require("path");

// Per-project pointer to the group's shared docs repo, committed in the code
// repo so any dev who clones it finds the docs without local setup:
//   .living-docs/docs.json -> { "docsRepo": "<git url>|null", "docsPath": "../docs" }
// docsPath is relative to the code repo root and defaults to the
// project-group layout (acme/api -> acme/docs).
const CONFIG_DIR = ".living-docs";
const CONFIG_FILE = "docs.json";
const DEFAULT_DOCS_PATH = "../docs";

function findConfig(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONFIG_DIR, CONFIG_FILE);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Returns { docsDir, repoUrl, source } or null when the project has no docs.
// `legacy` = projects wired up before .living-docs/docs.json existed: docs/ one
// level above cwd, no repo URL. Kept so those 13 repos keep working untouched.
function resolveDocs(cwd) {
  const configPath = findConfig(cwd);
  if (configPath) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const repoRoot = path.dirname(path.dirname(configPath));
      return {
        docsDir: path.resolve(repoRoot, cfg.docsPath || DEFAULT_DOCS_PATH),
        repoUrl: cfg.docsRepo || null,
        reviewers: Array.isArray(cfg.reviewers) ? cfg.reviewers.filter((r) => typeof r === "string") : [],
        // Implementation edits from unmerged code branches wait for the merge;
        // "holdUnmerged": false in .living-docs/docs.json opts a project out.
        holdUnmerged: cfg.holdUnmerged !== false,
        source: "config",
      };
    } catch {
      // malformed config — fall through to the legacy layout
    }
  }

  const legacyDir = path.join(path.dirname(cwd), "docs");
  if (fs.existsSync(legacyDir)) {
    return { docsDir: legacyDir, repoUrl: null, reviewers: [], holdUnmerged: true, source: "legacy" };
  }
  return null;
}

// Never overwrites: an existing config is someone's decision (e.g. a real
// docsRepo URL), not something init should reset.
function writeConfigIfMissing(repoRoot, { docsRepo = null, docsPath = DEFAULT_DOCS_PATH } = {}) {
  const configPath = path.join(repoRoot, CONFIG_DIR, CONFIG_FILE);
  if (fs.existsSync(configPath)) return { created: false, configPath };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ docsRepo, docsPath }, null, 2) + "\n");
  return { created: true, configPath };
}

// Unlike writeConfigIfMissing this deliberately overwrites the fields it is
// given: publishing the docs is the moment `docsRepo` goes from null to a real
// URL, and reviewers are a deliberate choice of who is asked to approve.
function setDocsConfig(cwd, patch) {
  const existing = findConfig(cwd);
  const configPath = existing || path.join(cwd, CONFIG_DIR, CONFIG_FILE);
  let cfg = { docsRepo: null, docsPath: DEFAULT_DOCS_PATH };
  if (existing) {
    try {
      cfg = { ...cfg, ...JSON.parse(fs.readFileSync(existing, "utf-8")) };
    } catch {
      // unreadable config — rewrite it with defaults plus the patch
    }
  }
  Object.assign(cfg, patch);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  return configPath;
}

const setDocsRepo = (cwd, docsRepo) => setDocsConfig(cwd, { docsRepo });

module.exports = { resolveDocs, writeConfigIfMissing, setDocsRepo, setDocsConfig, findConfig };
