const path = require("path");
const { spawnSync } = require("child_process");
const { git, isGitRepo, parseOrigin } = require("./git.cjs");
const { resolveDocs, setDocsRepo, setDocsConfig } = require("./docs-config.cjs");
const { originOf } = require("./docs-sync.cjs");
const { installDocsTooling, discoverCodeRepos } = require("./docs-install.cjs");

// The shared docs repo is created next to the code, under the same owner and
// with the same protocol as the code repo's own origin — no org is hardcoded.
function createOnGithub(cwd, docsDir) {
  const origin = parseOrigin(originOf(cwd));
  if (!origin) {
    throw new Error("--create needs a GitHub `origin` on the code repo to infer the owner; pass --repo <url> instead");
  }
  const name = `${path.basename(path.dirname(docsDir))}-docs`;
  const created = spawnSync("gh", ["repo", "create", `${origin.owner}/${name}`, "--private"], {
    cwd: docsDir,
    encoding: "utf-8",
    timeout: 60000,
  });
  if (created.error && created.error.code === "ENOENT") throw new Error("`gh` is not installed");
  if (created.status !== 0) throw new Error(`gh repo create failed: ${(created.stderr || "").trim()}`);
  return {
    url: origin.ssh ? `git@github.com:${origin.owner}/${name}.git` : `https://github.com/${origin.owner}/${name}.git`,
    name: `${origin.owner}/${name}`,
  };
}

// Turns a project group's local docs/ folder into the shared docs repo and
// records it in .living-docs/docs.json. The person running it is the one deciding
// to publish, so the initial commit is theirs, not the automation's.
function publishDocs({ cwd, repo, create, reviewers = [] }) {
  const docs = resolveDocs(cwd);
  if (!docs || !require("fs").existsSync(docs.docsDir)) {
    throw new Error("no docs folder found for this project — run `living-docs init --target claude-code` first");
  }
  const { docsDir } = docs;

  if (reviewers.length > 0) setDocsConfig(cwd, { reviewers });

  const existing = originOf(docsDir);
  if (existing) {
    if (!docs.repoUrl) setDocsRepo(cwd, existing);
    return { docsDir, url: existing, alreadyPublished: true };
  }
  if (!repo && !create) throw new Error("pass --repo <url> to use an existing repo, or --create to create one on GitHub");

  let url = repo;
  let created = null;
  if (!url) {
    created = createOnGithub(cwd, docsDir);
    url = created.url;
  }

  if (!isGitRepo(docsDir)) {
    const init = git(docsDir, ["init", "-b", "main"]);
    if (!init.ok) throw new Error(`git init failed: ${init.stderr}`);
  }
  // The automation goes in the same initial import: the person publishing is
  // the one deciding to turn it on. Later versions arrive as an upgrade PR.
  const origin = parseOrigin(originOf(cwd));
  const tooling = installDocsTooling(docsDir, {
    codeRepos: discoverCodeRepos(docsDir, origin ? [`${origin.owner}/${origin.repo}`] : []),
    owners: docs.reviewers.concat(reviewers),
  });
  git(docsDir, ["add", "-A"]);
  if (!git(docsDir, ["diff", "--cached", "--quiet"]).ok) {
    const commit = git(docsDir, ["commit", "-m", "docs: initial import"]);
    if (!commit.ok) throw new Error(`could not commit the initial docs (is git user.name/email set?): ${commit.stderr}`);
  }

  git(docsDir, ["remote", "add", "origin", url]);
  const branch = git(docsDir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "main";
  const pushed = git(docsDir, ["push", "-u", "origin", branch], { timeout: 60000 });
  if (!pushed.ok) throw new Error(`push to ${url} failed: ${pushed.stderr.split("\n")[0]}`);

  setDocsRepo(cwd, url);
  return { docsDir, url, created, alreadyPublished: false, tooling };
}

module.exports = { publishDocs, parseOrigin };
