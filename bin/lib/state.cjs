const fs = require("fs");
const os = require("os");
const path = require("path");

// Everything the hooks keep on this machine: logs, the proposals queue,
// private working clones, locks and the per-session ledger.
//
// Deliberately NOT under ~/.claude: Claude Code refuses to write in any
// directory beneath it, even with the tools allowed, so an extraction whose
// working directory is inside ~/.claude can read the docs but never edit them
// (it just asks "May I proceed?"). The private clones live here for that reason.
function stateDir() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  const dir = path.join(base, "living-docs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const MAX_LOG_BYTES = 1024 * 1024;

// One rotated generation is enough: the log exists to explain recent problems,
// not to be an archive, and it must not grow without bound on a long-lived
// machine.
function logFile() {
  const file = path.join(stateDir(), "capture.log");
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
  return file;
}

// Lines that mean the automation could not do its job (as opposed to lines that
// record it enforcing policy, like a reverted edit). Shown to the developer at
// session start and by `doctor`, so silent failure can't go unnoticed.
const FAILURE_PATTERN =
  /extraction failed|clone of .* failed|failed to run|still can't be pushed|could not open PR|could not commit|push of .* failed|sync failed|skipping this one|remote unreachable|no longer rebase|policy outdated/;

function lineTime(line) {
  const match = line.match(/^\[([^\]]+)\]/);
  return match ? Date.parse(match[1]) : NaN;
}

function recentProblems(days = 3) {
  try {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return fs
      .readFileSync(logFile(), "utf-8")
      .split("\n")
      .filter((line) => FAILURE_PATTERN.test(line) && lineTime(line) >= cutoff);
  } catch {
    return [];
  }
}

// Per-session ledger: how much of each transcript has already been filed, so a
// session that compacted and then ended is not captured twice.
const LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function ledgerPath() {
  return path.join(stateDir(), "sessions.json");
}

function readLedger() {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(), "utf-8"));
  } catch {
    return {};
  }
}

function capturedOffset(sessionId) {
  return (readLedger()[sessionId] || {}).offset || 0;
}

function markCaptured(sessionId, offset) {
  if (!sessionId) return;
  const ledger = readLedger();
  const previous = (ledger[sessionId] || {}).offset || 0;
  ledger[sessionId] = { offset: Math.max(previous, offset), at: Date.now() };
  for (const [id, entry] of Object.entries(ledger)) {
    if (Date.now() - entry.at > LEDGER_TTL_MS) delete ledger[id];
  }
  fs.writeFileSync(ledgerPath(), JSON.stringify(ledger));
}

module.exports = { stateDir, logFile, recentProblems, lineTime, capturedOffset, markCaptured, FAILURE_PATTERN };
