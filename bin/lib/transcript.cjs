const fs = require("fs");
const path = require("path");

// Turns a Claude Code session transcript (JSONL) into the text an extraction
// run reads. Only what carries decisions survives: what the user asked, what
// the assistant said, and which files it changed. Thinking blocks, tool output
// and subagent chatter are dropped.

const MAX_CHARS = 40000;
const HEAD_CHARS = 4000;
// A session below this isn't worth a model call: no real discussion happened.
const MIN_USER_TURNS = 3;
const MIN_CHARS = 1500;
// A branch visited only briefly (one `git checkout` and a question) isn't worth
// its own model call; at most this many branches are processed per capture.
const MIN_SEGMENT_TURNS = 1;
const MIN_SEGMENT_CHARS = 400;
const MAX_SEGMENTS = 4;

// Entries keep their line index (unparseable lines stay as null) so offsets
// recorded in the ledger keep meaning the same thing.
function readTranscript(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });
}

// Best-effort fallback: everything before the last compaction was already
// captured by the PostCompact hook. The exact marker shape could not be
// observed on this machine, so both known spellings are accepted and the
// ledger (not this) is the primary record.
function markerOffset(entries) {
  let last = -1;
  entries.forEach((e, i) => {
    if (e && (e.isCompactSummary === true || (e.type === "system" && e.subtype === "compact_boundary"))) last = i;
  });
  return last + 1;
}

function clean(text) {
  return (text || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

function userText(entry) {
  const content = entry.message && entry.message.content;
  if (typeof content === "string") return clean(content);
  if (!Array.isArray(content)) return "";
  return clean(content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
}

function describeTool(block, cwd) {
  const input = block.input || {};
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(block.name) && input.file_path) {
    return `edited ${cwd ? path.relative(cwd, input.file_path) || input.file_path : input.file_path}`;
  }
  if (block.name === "Bash" && input.command) return `ran: ${String(input.command).slice(0, 160)}`;
  return null;
}

function condense(entries, { from = 0, cwd, filter } = {}) {
  const parts = [];
  let userTurns = 0;

  for (let i = from; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.isSidechain || entry.isMeta || entry.isCompactSummary) continue;
    if (filter && !filter(entry, i)) continue;

    if (entry.type === "user") {
      const text = userText(entry);
      if (text) {
        parts.push(`[user] ${text}`);
        userTurns++;
      }
    } else if (entry.type === "assistant") {
      for (const block of (entry.message && entry.message.content) || []) {
        if (block.type === "text" && block.text.trim()) parts.push(`[assistant] ${block.text.trim()}`);
        else if (block.type === "tool_use") {
          const what = describeTool(block, cwd);
          if (what) parts.push(`[assistant] (${what})`);
        }
      }
    }
  }

  let text = parts.join("\n\n");
  if (text.length > MAX_CHARS) {
    // Decisions cluster late in a session; keep the opening (the goal) and the end.
    text = `${text.slice(0, HEAD_CHARS)}\n\n[... middle of the conversation omitted ...]\n\n${text.slice(-(MAX_CHARS - HEAD_CHARS))}`;
  }
  return { text, userTurns, chars: text.length, endOffset: entries.length };
}

function worthCapturing({ userTurns, chars }) {
  return userTurns >= MIN_USER_TURNS && chars >= MIN_CHARS;
}

// Claude Code stamps every entry with the git branch it was on. "HEAD" means it
// could not tell (detached, or not a repo), which is treated as unknown rather
// than as a branch called HEAD.
function branchOf(entry) {
  const b = entry && entry.gitBranch;
  return typeof b === "string" && b && b !== "HEAD" ? b : null;
}

// A session can hop between branches before it ends or compacts, and each
// branch's docs edits wait for that branch's code to merge — so the discussion
// is split by branch. Entries with no recorded branch belong to the last known
// one (branch `null` = unknown, resolved to the current HEAD by the caller).
// Only branches with a real discussion are kept, biggest first.
function segments(entries, { from = 0, cwd } = {}) {
  const owner = new Map();
  let current = null;
  for (let i = from; i < entries.length; i++) {
    const b = branchOf(entries[i]);
    if (b) current = b;
    owner.set(i, current);
  }

  const branches = [...new Set(owner.values())];
  return branches
    .map((branch) => ({ branch, ...condense(entries, { from, cwd, filter: (_, i) => owner.get(i) === branch }) }))
    .filter((s) => s.userTurns >= MIN_SEGMENT_TURNS && s.chars >= MIN_SEGMENT_CHARS)
    .sort((a, b) => b.chars - a.chars)
    .slice(0, MAX_SEGMENTS);
}

module.exports = { readTranscript, markerOffset, condense, segments, branchOf, worthCapturing, MAX_CHARS, MIN_USER_TURNS, MIN_CHARS };
