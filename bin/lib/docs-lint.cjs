const fs = require("fs");
const path = require("path");

// Checks the documentation policy can enforce mechanically. Run by the capture
// worker *before* it pushes: with direct-to-main pushes, a CI lint only tells
// you afterwards that a bad change already landed.

// glossary/troubleshooting are list-shaped (see the policy), the rest use
// Context / Implementation / Decision History.
const LIST_MODULES = { glossary: "Terms", troubleshooting: "Issues" };

const SECRET_PATTERNS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["API key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["hardcoded credential", /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{16,}/i],
];

// Indexes of `## ` headings, ignoring any inside code fences.
function headingIndexes(lines) {
  let fenced = false;
  const found = [];
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (!fenced && line.startsWith("## ")) found.push(i);
  });
  return found;
}

function sectionBounds(lines, name) {
  const headings = headingIndexes(lines);
  const start = headings.find((i) => lines[i] === `## ${name}`);
  if (start === undefined) return null;
  const end = headings.find((i) => i > start);
  return { start, end: end === undefined ? lines.length : end };
}

function getSection(md, name) {
  const lines = md.split("\n");
  const bounds = sectionBounds(lines, name);
  if (!bounds) return null;
  return lines.slice(bounds.start + 1, bounds.end).join("\n").replace(/\s+$/, "");
}

// Replaces a section's body, keeping the blank lines that separated it from
// the next heading so the rest of the file's layout doesn't move.
function replaceSection(md, name, body) {
  const lines = md.split("\n");
  const bounds = sectionBounds(lines, name);
  if (!bounds) return md;
  const old = lines.slice(bounds.start + 1, bounds.end);
  let trailing = 0;
  while (trailing < old.length && old[old.length - 1 - trailing].trim() === "") trailing++;
  const next = body.split("\n");
  while (next.length && next[next.length - 1].trim() === "") next.pop();
  return [
    ...lines.slice(0, bounds.start + 1),
    ...next,
    ...Array(trailing).fill(""),
    ...lines.slice(bounds.end),
  ].join("\n");
}

function removeSection(md, name) {
  const lines = md.split("\n");
  const bounds = sectionBounds(lines, name);
  if (!bounds) return md;
  return [...lines.slice(0, bounds.start), ...lines.slice(bounds.end)].join("\n");
}

// Like replaceSection, but inserts the section (before Implementation, else at
// the end) when the file doesn't have it yet.
function setSection(md, name, body) {
  const lines = md.split("\n");
  if (sectionBounds(lines, name)) return replaceSection(md, name, body);
  const impl = sectionBounds(lines, "Implementation");
  const block = [`## ${name}`, ...body.split("\n"), ""];
  if (impl) return [...lines.slice(0, impl.start), ...block, ...lines.slice(impl.start)].join("\n");
  return [...lines.filter((_, i, a) => i < a.length - 1 || a[i] !== ""), "", ...block].join("\n");
}

function contextChanged(before, after) {
  const a = getSection(before, "Context");
  const b = getSection(after, "Context");
  if (b === null) return false; // removal is a lint violation, not a Context edit
  if (a === null) return b.trim() !== ""; // a legacy file gaining Context is still a Context change
  return a.trim() !== b.trim();
}

function shapeOk(md, slug) {
  if (LIST_MODULES[slug]) return getSection(md, LIST_MODULES[slug]) !== null;
  const lines = md.split("\n");
  const order = ["Context", "Implementation", "Decision History"].map((name) => {
    const b = sectionBounds(lines, name);
    return b ? b.start : -1;
  });
  return order.every((n) => n >= 0) && order[0] < order[1] && order[1] < order[2];
}

// Decision History is append-only: every existing entry line must survive
// unchanged. The stub's empty "- " bullet is a placeholder, not
// an entry, so the first real entry may replace it.
function decisionEntries(md) {
  return (getSection(md, "Decision History") || "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "" && !/^-\s*$/.test(l));
}

// Existing entries must all survive unchanged and in their original relative
// order. Where a *new* entry sits is not a safety question (models tend to put
// it first or last), so it isn't enforced here — the policy states the
// convention instead of the lint rejecting a valid capture over it.
function appendOnly(before, after) {
  const was = decisionEntries(before);
  const now = decisionEntries(after);
  let at = 0;
  for (const entry of was) {
    const found = now.indexOf(entry, at);
    if (found === -1) return false;
    at = found + 1;
  }
  return true;
}

function listEntries(md, slug) {
  return (getSection(md, LIST_MODULES[slug]) || "")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

function findSecrets(before, after) {
  const known = new Set(before.split("\n"));
  const added = after.split("\n").filter((l) => !known.has(l));
  const hits = [];
  for (const line of added) {
    for (const [label, pattern] of SECRET_PATTERNS) {
      if (pattern.test(line)) hits.push(label);
    }
  }
  return [...new Set(hits)];
}

// Appends a source tag to every *new* entry of a list section, mechanically,
// so provenance can't be forgotten by the extraction step. An entry is a "- "
// line plus any indented/continuation lines after it; the tag goes on its last
// line. Existing entries are never touched.
function tagNewEntries(before, after, section, tag) {
  const lines = after.split("\n");
  const bounds = sectionBounds(lines, section);
  if (!bounds) return after;

  const known = new Set(before.split("\n"));
  const body = lines.slice(bounds.start + 1, bounds.end);
  const out = [];
  let i = 0;
  while (i < body.length) {
    if (!/^- /.test(body[i])) {
      out.push(body[i++]);
      continue;
    }
    let j = i + 1;
    while (j < body.length && body[j].trim() !== "" && !/^- /.test(body[j])) j++;
    const entry = body.slice(i, j);
    if (!known.has(entry[0]) && !entry.some((l) => l.includes("(src:"))) {
      entry[entry.length - 1] = `${entry[entry.length - 1].replace(/\s+$/, "")} (src: ${tag})`;
    }
    out.push(...entry);
    i = j;
  }
  return [...lines.slice(0, bounds.start + 1), ...out, ...lines.slice(bounds.end)].join("\n");
}

// Lines present in `after` but not in `before` (multiset difference, order
// kept). Used to lift just the *new* Decision History entries out of a held
// change, so they can be published while the rest of the change waits.
function addedLines(before, after) {
  const pool = new Map();
  for (const line of (before || "").split("\n")) pool.set(line, (pool.get(line) || 0) + 1);
  const added = [];
  for (const line of (after || "").split("\n")) {
    if (pool.get(line) > 0) pool.set(line, pool.get(line) - 1);
    else if (line.trim() !== "" && !/^-\s*$/.test(line)) added.push(line);
  }
  return added;
}

// Appends lines to the end of a section, replacing the stub's empty "- "
// bullet. A no-op for lines already present, so a retried push can't duplicate.
function appendToSection(md, name, lines) {
  const body = getSection(md, name);
  if (body === null) return md;
  const have = new Set(body.split("\n"));
  const fresh = lines.filter((l) => !have.has(l));
  if (fresh.length === 0) return md;
  const kept = body.split("\n").filter((l) => !/^-\s*$/.test(l));
  return replaceSection(md, name, [...kept, ...fresh].join("\n"));
}

// Returns human-readable violations for one module file's change.
function lintChange({ slug, before, after }) {
  const violations = [];
  if (before !== null && shapeOk(before, slug) && !shapeOk(after, slug)) {
    violations.push("breaks the module's required section structure");
  }
  if (before !== null && getSection(before, "Context") !== null && getSection(after, "Context") === null) {
    violations.push("removes the Context section");
  }
  if (LIST_MODULES[slug]) {
    if (before !== null && listEntries(after, slug).length < listEntries(before, slug).length) {
      violations.push("removes existing entries (mark them Deprecated/Obsolete instead)");
    }
  } else if (before !== null && !appendOnly(before, after)) {
    violations.push("edits or removes existing Decision History entries (append-only)");
  }
  const secrets = findSecrets(before || "", after);
  if (secrets.length > 0) violations.push(`adds what looks like a secret (${secrets.join(", ")})`);
  const injected = findInjection(before || "", after);
  if (injected.length > 0) violations.push(`adds text that reads as instructions to an AI (${injected.join(", ")})`);
  return violations;
}

// --- CI-level content checks -------------------------------------------------
// The docs are trusted context for every developer's Claude, so what is written
// into them is also an attack surface: text that talks *to* the model, or
// personal data that has no business in a shared repo.

// Text that only makes sense as an instruction to an AI reader. Failures.
const INJECTION_PATTERNS = [
  ["instruction override", /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,40}\b(instructions?|rules|prompts?|context)\b/i],
  ["fake system markup", /<\/?(system-reminder|system|assistant|instructions?)>|<\|im_(start|end)\|>/i],
  ["prompt exfiltration", /\b(reveal|print|repeat|output)\b[^.\n]{0,30}\b(system prompt|your instructions|hidden instructions)\b/i],
  ["pipe to shell", /\b(curl|wget)\b[^\n|]*\|\s*(ba|z)?sh\b/i],
  ["encoded blob", /[A-Za-z0-9+/=]{300,}/],
];

// Personal data. Warnings: legitimate docs mention a contact now and then.
function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt && (n *= 2) > 9) n -= 9;
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function addedText(before, after) {
  const known = new Set((before || "").split("\n"));
  return after.split("\n").filter((l) => !known.has(l));
}

function findInjection(before, after) {
  const hits = new Set();
  for (const line of addedText(before, after)) {
    for (const [label, pattern] of INJECTION_PATTERNS) if (pattern.test(line)) hits.add(label);
  }
  return [...hits];
}

function findPii(before, after) {
  const hits = new Set();
  for (const line of addedText(before, after)) {
    if (/[A-Za-z0-9._%+-]+@(?!example\.(com|org)\b)[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(line) && !/\(src: /.test(line.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g, ""))) hits.add("email address");
    if (/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/.test(line)) hits.add("IBAN-like number");
    for (const m of line.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= 13 && luhn(digits)) hits.add("payment card number");
    }
  }
  return [...hits];
}

// A "Supersedes <date> ..." entry must point at a date that exists earlier in
// the same module, otherwise it corrects nothing.
function checkSupersedes(md) {
  const entries = decisionEntries(md);
  const problems = [];
  entries.forEach((entry, i) => {
    const m = /Supersedes\s+(\d{4}-\d{2}-\d{2})/i.exec(entry);
    if (!m) return;
    const earlier = entries.slice(0, i).some((e) => e.includes(m[1]));
    if (!earlier) problems.push(`"Supersedes ${m[1]}" has no earlier entry with that date`);
  });
  return problems;
}

// INDEX.md must list every module and only modules that exist. Used by
// `doctor` now, and by the docs-repo CI later.
function checkIndex(docsDir) {
  const problems = [];
  const indexPath = path.join(docsDir, "INDEX.md");
  if (!fs.existsSync(indexPath)) return ["INDEX.md is missing"];

  const index = fs.readFileSync(indexPath, "utf-8");
  const linked = new Set([...index.matchAll(/\(modules\/([^)]+\.md)\)/g)].map((m) => m[1]));
  const modulesDir = path.join(docsDir, "modules");
  const onDisk = fs.existsSync(modulesDir)
    ? fs.readdirSync(modulesDir).filter((f) => f.endsWith(".md"))
    : [];

  onDisk.filter((f) => !linked.has(f)).forEach((f) => problems.push(`modules/${f} is not listed in INDEX.md`));
  [...linked].filter((f) => !onDisk.includes(f)).forEach((f) => problems.push(`INDEX.md links modules/${f}, which does not exist`));
  return problems;
}

module.exports = {
  getSection,
  replaceSection,
  removeSection,
  setSection,
  contextChanged,
  addedLines,
  appendToSection,
  tagNewEntries,
  lintChange,
  checkIndex,
  shapeOk,
  appendOnly,
  findSecrets,
  findInjection,
  findPii,
  checkSupersedes,
  decisionEntries,
  LIST_MODULES,
};
