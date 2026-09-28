const fs = require("fs");
const path = require("path");

// Standing topics: cross-cutting context that isn't a business domain but
// that a new engineer (or Claude) needs to make good calls. Seeded by init;
// their content is maintained autonomously like any module, but adding or
// removing a topic is a human decision (PR), same as a business domain.
// A topic earns a slot only if: no single domain owns it, conversations
// regularly produce it, a newcomer would go wrong without it, and code/README/
// the team's own guidelines don't already cover it better.
const STANDING_TOPICS = [
  {
    slug: "architecture",
    description: "how the pieces fit together, which repo owns what; cross-cutting patterns no single domain owns",
  },
  {
    slug: "deployment",
    description: "environments, pipelines, release process and infra configuration",
  },
  {
    slug: "integrations",
    description: "third-party and external systems: contracts, failure modes, ownership",
  },
  {
    slug: "glossary",
    description: "shared vocabulary, so the same term means the same thing across domains",
  },
  {
    slug: "troubleshooting",
    description: "symptom, cause and fix for non-obvious problems, and known gotchas",
  },
];

// Offered at init (--topics / prompt), not seeded by default: they only earn
// their place in some groups, and empty stubs are noise.
const OPTIONAL_TOPICS = [
  {
    slug: "security",
    description: "access model, secrets handling and compliance constraints",
  },
  {
    slug: "data-model",
    description: "cross-domain entities, relationships and migration conventions",
  },
  {
    slug: "local-dev",
    description: "getting the whole group running locally",
  },
];

const STANDING_HEADING = "## Standing topics";
const DOMAINS_HEADING = "## Business domains";
const EMPTY_DOMAINS = /^_\(none yet/;

function titleCase(s) {
  return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Marker so an agent reading a fresh stub doesn't mistake blank bullets for
// documented fact. Whoever writes the first real content removes it.
const NOT_DOCUMENTED = "_Not yet documented._";

// glossary and troubleshooting are lists of entries, not modules with a
// use case and architecture, so they get their own shape (see the policy).
const LIST_SHAPES = {
  glossary: "Terms",
  troubleshooting: "Issues",
};

function moduleStub(title, slug) {
  if (LIST_SHAPES[slug]) {
    return `# ${title}\n\n${NOT_DOCUMENTED}\n\n## ${LIST_SHAPES[slug]}\n\n`;
  }
  return `# ${title}\n\n${NOT_DOCUMENTED}\n\n## Context\n- Use case: \n- Limitations: \n- Restrictions / constraints: \n\n## Implementation\n- \n\n## Decision History\n- \n`;
}

function indexLine({ slug, title, description }) {
  return `- [${title || titleCase(slug)}](modules/${slug}.md) — ${description}`;
}

// Adds one line under the right INDEX.md heading, replacing the "(none yet)"
// placeholder if present. Works on whole lines under an exact heading match,
// so it never edits anything outside that section.
function addToIndex(indexPath, module) {
  const lines = fs.readFileSync(indexPath, "utf-8").split("\n");
  if (lines.some((l) => l.includes(`(modules/${module.slug}.md)`))) return false;

  const heading = module.kind === "standing-topic" ? STANDING_HEADING : DOMAINS_HEADING;
  let at = lines.indexOf(heading);
  if (at === -1) {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push("", heading);
    at = lines.length - 1;
  }

  let end = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  if (end === -1) end = lines.length;

  const body = lines
    .slice(at + 1, end)
    .filter((l) => !EMPTY_DOMAINS.test(l) && l.trim() !== "");
  body.push(indexLine(module));

  const tail = lines.slice(end);
  const rebuilt = [...lines.slice(0, at + 1), "", ...body, ...(tail.length ? [""] : []), ...tail];
  fs.writeFileSync(indexPath, rebuilt.join("\n").replace(/\n*$/, "\n"));
  return true;
}

// Writes the module stub and its INDEX line. Shared by init (direct, when the
// docs repo is brand new) and the PR flow (on a branch), so a module looks the
// same however it was created. Never overwrites an existing module file.
function createModule(docsDir, module) {
  const file = path.join(docsDir, "modules", `${module.slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return { created: false, file };
  fs.writeFileSync(file, moduleStub(module.title || titleCase(module.slug), module.slug));
  addToIndex(path.join(docsDir, "INDEX.md"), module);
  return { created: true, file };
}

module.exports = { STANDING_TOPICS, OPTIONAL_TOPICS, createModule, addToIndex, titleCase, moduleStub };
