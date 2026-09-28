const fs = require("fs");
const { spawnSync } = require("child_process");

// Hooks run detached with no terminal: any credential or passphrase prompt
// would hang forever instead of failing, so every git call is non-interactive.
function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
  };
}

function git(dir, args, { timeout = 30000, identity } = {}) {
  const prefix = identity
    ? ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`]
    : [];
  const result = spawnSync("git", [...prefix, ...args], {
    cwd: dir,
    encoding: "utf-8",
    timeout,
    env: gitEnv(),
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").trim(),
    raw: result.stdout || "", // untrimmed, for exact file-content comparisons
    stderr: (result.stderr || "").trim(),
    status: result.status,
    error: result.error,
  };
}

function isGitRepo(dir) {
  return fs.existsSync(dir) && git(dir, ["rev-parse", "--git-dir"]).ok;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Cross-process lock via O_EXCL. Two sessions compacting at once must not run
// two extractions against the same clone. A lock is stale if its owner died or
// it outlived any run that could still be healthy.
function withLock(lockPath, fn, { waitMs = 120000, staleMs = 15 * 60 * 1000 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = Number(fs.readFileSync(lockPath, "utf-8"));
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > staleMs || (owner && !pidAlive(owner))) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // lock vanished between checks — retry
      }
      if (Date.now() - start > waitMs) return { locked: false };
      sleepSync(500);
    }
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone
    }
  }
}

// git@github.com:owner/repo.git or https://github.com/owner/repo(.git)
function parseOrigin(url) {
  const match = (url || "").match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? { owner: match[1], repo: match[2], ssh: url.startsWith("git@") } : null;
}

module.exports = { git, isGitRepo, withLock, parseOrigin };
