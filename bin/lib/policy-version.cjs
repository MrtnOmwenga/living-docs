const fs = require("fs");
const path = require("path");

// The documentation policy carries its own version (`<!-- policy-version: N -->`)
// and the docs repo records the version it was last brought up to
// (.living-docs/policy.json). Developers run different tool versions, so the two are
// compared before a capture: an older tool writing under a newer policy would
// produce edits the newer rules reject, and is better off not writing at all.

// In the package the policy is policy/documentation-policy.md; a copy of this
// library installed into a docs repo (.living-docs/ci/lib) sits next to a plain
// documentation-policy.md instead.
function policyPath() {
  const candidates = [
    process.env.LIVING_DOCS_POLICY_PATH,
    path.join(__dirname, "..", "..", "policy", "documentation-policy.md"),
    path.join(__dirname, "..", "documentation-policy.md"),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || candidates[1];
}
const RECORD = path.join(".living-docs", "policy.json");

function parseVersion(text) {
  const match = /<!--\s*policy-version:\s*(\d+)\s*-->/.exec(text || "");
  return match ? Number(match[1]) : 1;
}

function packagePolicyVersion() {
  try {
    return parseVersion(fs.readFileSync(policyPath(), "utf-8"));
  } catch {
    return 1;
  }
}

// Docs repos created before versioning have no record, which means version 1.
function recordedVersion(dir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, RECORD), "utf-8"));
    return Number.isInteger(cfg.policyVersion) ? cfg.policyVersion : 1;
  } catch {
    return 1;
  }
}

function writeRecord(dir, version = packagePolicyVersion()) {
  const file = path.join(dir, RECORD);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ policyVersion: version }, null, 2) + "\n");
  return file;
}

// "older": this tool is behind the docs (refuse to write). "newer": the docs
// haven't been upgraded (write, but say so). "same": fine.
function compareVersions(dir) {
  const tool = packagePolicyVersion();
  const docs = recordedVersion(dir);
  return { tool, docs, relation: tool < docs ? "older" : tool > docs ? "newer" : "same" };
}

module.exports = { policyPath, packagePolicyVersion, recordedVersion, writeRecord, compareVersions, parseVersion, RECORD };
