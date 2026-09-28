const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOKS = [
  { event: "PostCompact", matcher: "*", command: "living-docs hook capture" },
  { event: "SessionStart", matcher: "compact", command: "living-docs hook remind" },
  { event: "SessionStart", matcher: "startup|resume", command: "living-docs hook sync" },
  { event: "SessionEnd", matcher: "*", command: "living-docs hook capture-session" },
];

function settingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

// Idempotent merge into ~/.claude/settings.json. Refuses to touch a file it
// can't parse — clobbering someone's global settings is worse than skipping.
function installHooks(file = settingsPath()) {
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (error) {
      throw new Error(`${file} is not valid JSON (${error.message}) — left untouched`);
    }
  }

  const before = JSON.stringify(settings);
  settings.hooks = settings.hooks || {};

  for (const { event, matcher, command } of HOOKS) {
    const groups = (settings.hooks[event] = settings.hooks[event] || []);
    const present = groups.some(
      (g) => g.matcher === matcher && (g.hooks || []).some((h) => h.command === command)
    );
    if (!present) groups.push({ matcher, hooks: [{ type: "command", command }] });
  }

  const changed = JSON.stringify(settings) !== before;
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-living-docs`);
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  }
  return { changed, file };
}

module.exports = { installHooks, HOOKS };
