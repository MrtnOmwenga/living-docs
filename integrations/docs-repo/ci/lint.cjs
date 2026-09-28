#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { lib, annotate, summary } = require("./_lib.cjs");
const { git } = lib("git");
const lint = lib("docs-lint");

// Second line of defence behind the worker's own lint: it runs on every PR and
// push to the docs repo, so a human edit (or a worker from an old tool version)
// is held to the same rules. Errors fail the check; warnings only annotate.
//
//   node lint.cjs [--base <ref>]   (default: origin/$GITHUB_BASE_REF, else the whole tree)

function baseRef(argv) {
  const at = argv.indexOf("--base");
  if (at !== -1) return argv[at + 1];
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return null;
}

function changedModules(dir, base) {
  if (!base || /^0+$/.test(base) || !git(dir, ["rev-parse", "--verify", "--quiet", base]).ok) return null;
  const out = git(dir, ["-c", "core.quotepath=off", "diff", "--name-status", `${base}...HEAD`]).stdout;
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, file] = line.split("\t");
      return { status: status[0], file };
    })
    .filter(({ file }) => /^modules\/[^/]+\.md$/.test(file || ""));
}

function run({ dir = process.cwd(), base = null } = {}) {
  const errors = [];
  const warnings = [];
  const err = (file, msg) => errors.push({ file, msg });
  const warn = (file, msg) => warnings.push({ file, msg });

  const changes = changedModules(dir, base);
  const files =
    changes ||
    (fs.existsSync(path.join(dir, "modules")) ? fs.readdirSync(path.join(dir, "modules")).filter((f) => f.endsWith(".md")).map((f) => ({ status: "A", file: `modules/${f}` })) : []);

  for (const { status, file } of files) {
    if (status === "D") continue;
    const slug = path.basename(file, ".md");
    const after = fs.readFileSync(path.join(dir, file), "utf-8");
    const before = changes && status === "M" ? git(dir, ["show", `${base}:${file}`]).raw : null;

    lint.lintChange({ slug, before, after }).forEach((v) => err(file, v));
    // A brand-new (or whole-tree) file has no "before": still refuse a broken shape.
    if (before === null && !lint.shapeOk(after, slug)) err(file, "does not have the module's required section structure");
    lint.checkSupersedes(after).forEach((v) => warn(file, v));
    lint.findPii(before || "", after).forEach((v) => warn(file, `possible personal data: ${v}`));
  }

  lint.checkIndex(dir).forEach((p) => err("INDEX.md", p));
  return { errors, warnings, checked: files.length };
}

if (require.main === module) {
  const result = run({ base: baseRef(process.argv.slice(2)) });
  result.errors.forEach((e) => annotate("error", e.msg, e.file));
  result.warnings.forEach((w) => annotate("warning", w.msg, w.file));
  summary(`### Docs lint\n${result.checked} module file(s) checked — ${result.errors.length} error(s), ${result.warnings.length} warning(s).`);
  process.exit(result.errors.length ? 1 : 0);
}

module.exports = { run };
