const fs = require("fs");
const path = require("path");

// These scripts run in two places: from the package (integrations/docs-repo/ci,
// library at bin/lib) and from a docs repo they were installed into
// (.living-docs/ci, library copied to .living-docs/ci/lib). Same code, same tests.
function lib(name) {
  const installed = path.join(__dirname, "lib", `${name}.cjs`);
  return require(fs.existsSync(installed) ? installed : path.join(__dirname, "..", "..", "..", "bin", "lib", `${name}.cjs`));
}

function annotate(level, message, file) {
  const where = file ? ` file=${file}` : "";
  console.log(`::${level}${where}::${String(message).replace(/\r?\n/g, " ")}`);
}

function summary(markdown) {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
}

// Posts to Slack when SLACK_WEBHOOK_URL is set; a missing webhook is normal
// (it is added later as a repo/org secret), so it is a quiet no-op.
async function slack(text, { fetchImpl = globalThis.fetch, url = process.env.SLACK_WEBHOOK_URL } = {}) {
  if (!url) return { sent: false, reason: "no webhook configured" };
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    return { sent: res.ok, reason: res.ok ? "" : `HTTP ${res.status}` };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}

module.exports = { lib, annotate, summary, slack };
