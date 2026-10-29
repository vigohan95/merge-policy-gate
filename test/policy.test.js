import test from "node:test";
import assert from "node:assert/strict";
import { parsePolicy, parseMiniYaml, pathMatches, classifyDependencyDiff, evaluate, findJiraKey, verdictMessage, DEFAULT_POLICY } from "../src/policy.js";
import { policyTemplateText } from "../src/index.js";

const base = { changedFiles: ["src/app.py", "tests/test_app.py"], changedLines: 120, draft: false, approvalsByOthers: 0, dependencyChanges: [], jira: null };

test("plain change under the limits passes", () => {
  const d = evaluate(DEFAULT_POLICY, base);
  assert.equal(d.allowed, true);
  assert.deepEqual(d.violated, []);
  assert.ok(d.rules.includes("§2.1") && d.rules.includes("§3.4"));
});

test("protected path is held without an approval and released with one", () => {
  let d = evaluate(DEFAULT_POLICY, { ...base, changedFiles: ["Dockerfile"] });
  assert.equal(d.allowed, false);
  assert.deepEqual(d.violated, ["§2.1"]);
  d = evaluate(DEFAULT_POLICY, { ...base, changedFiles: ["Dockerfile"], approvalsByOthers: 1 });
  assert.equal(d.allowed, true);
  assert.ok(d.satisfied.includes("§3.6"));
});

test("directory globs and extension globs", () => {
  assert.equal(pathMatches(".github/workflows/ci.yml", [".github/**"]), true);
  assert.equal(pathMatches("docs/x.md", ["*.md"]), false);
  assert.equal(pathMatches("README.md", ["*.md"]), true);
  assert.equal(pathMatches("src/Dockerfile", ["Dockerfile"]), false);
});

test("size limits", () => {
  let d = evaluate(DEFAULT_POLICY, { ...base, changedLines: 401 });
  assert.deepEqual(d.violated, ["§3.4"]);
  const many = Array.from({ length: 21 }, (_, i) => `src/f${i}.py`);
  d = evaluate(DEFAULT_POLICY, { ...base, changedFiles: many, changedLines: 10 });
  assert.deepEqual(d.violated, ["§3.4"]);
});

test("drafts are held", () => {
  const d = evaluate(DEFAULT_POLICY, { ...base, draft: true });
  assert.deepEqual(d.violated, ["§3.5"]);
});

test("dependency classification for requirements and package.json", () => {
  const changes = classifyDependencyDiff("fastapi==0.110.0\nhttpx==0.27.0\n", "fastapi==0.110.3\nhttpx==1.0.0\nnewpkg==1.0\n");
  assert.deepEqual(changes, [
    { package: "fastapi", kind: "patch" },
    { package: "httpx", kind: "major" },
    { package: "newpkg", kind: "add" },
  ]);
  const pj = classifyDependencyDiff('{"dependencies":{"react":"18.2.0"}}', '{"dependencies":{"react":"18.3.1"},"devDependencies":{"vitest":"2.0.0"}}', "package.json");
  assert.deepEqual(pj, [
    { package: "react", kind: "minor" },
    { package: "vitest", kind: "add" },
  ]);
  let d = evaluate(DEFAULT_POLICY, { ...base, dependencyChanges: [{ package: "httpx", kind: "major" }] });
  assert.deepEqual(d.violated, ["§2.2"]);
  d = evaluate(DEFAULT_POLICY, { ...base, dependencyChanges: [{ package: "fastapi", kind: "patch" }] });
  assert.equal(d.allowed, true);
});

test("jira rule: key presence and optional status", () => {
  const withStatuses = { ...DEFAULT_POLICY, jira_allowed_statuses: ["In Progress", "In Review"] };
  let d = evaluate(withStatuses, { ...base, jira: { key: "KAN-1", found: true, status: "In Progress" } });
  assert.equal(d.allowed, true);
  d = evaluate(withStatuses, { ...base, jira: { key: "KAN-1", found: true, status: "Done" } });
  assert.deepEqual(d.violated, ["§4.1"]);
  d = evaluate(withStatuses, { ...base, jira: { key: "KAN-1", found: true, status: null } });
  assert.equal(d.allowed, true, "status unknown to the merge check: key presence only");
  d = evaluate({ ...DEFAULT_POLICY, jira_required: true }, { ...base, jira: null });
  assert.deepEqual(d.violated, ["§4.1"]);
  d = evaluate(DEFAULT_POLICY, { ...base, jira: { key: "KAN-1", found: true, status: "Done" } });
  assert.equal(d.allowed, true, "default policy does not check status");
});

test("jira key detection", () => {
  assert.equal(findJiraKey("feature/KAN-12-login", "x"), "KAN-12");
  assert.equal(findJiraKey("main", "Fix ABC-7: typo"), "ABC-7");
  assert.equal(findJiraKey("hotfix", "no key"), null);
  assert.equal(findJiraKey("sha256-12", ""), null);
});

test("policy block parsing and defaults", () => {
  const md = policyTemplateText();
  const { policy, source } = parsePolicy(md);
  assert.equal(source, "MERGE-POLICY.md");
  assert.deepEqual(policy.limits, { max_changed_lines: 400, max_changed_files: 20 });
  assert.deepEqual(policy.dependency_bumps.human, ["major", "add", "remove"]);
  assert.equal(policy.block_drafts, true);
  const custom = parsePolicy("# p\n```yaml merge-policy\nlimits:\n  max_changed_lines: 50  # tight\nprotected_paths: ['infra/**']\njira_allowed_statuses: []\n```\n");
  assert.equal(custom.policy.limits.max_changed_lines, 50);
  assert.equal(custom.policy.limits.max_changed_files, 20);
  assert.deepEqual(custom.policy.protected_paths, ["infra/**"]);
  assert.deepEqual(custom.policy.jira_allowed_statuses, []);
  assert.equal(parsePolicy(null).source, "default");
  assert.equal(parsePolicy("no block here").source, "default");
});

test("mini yaml handles quotes, comments and nested lists", () => {
  const y = parseMiniYaml('a: "x # not a comment"\nb: 3 # comment\nc:\n  - one\n  - "two"\nd:\n  k: true\n  l: [1, 2]\n');
  assert.deepEqual(y, { a: "x # not a comment", b: 3, c: ["one", "two"], d: { k: true, l: [1, 2] } });
});

test("verdict message cites rules", () => {
  const d = evaluate(DEFAULT_POLICY, { ...base, changedFiles: ["Dockerfile"] });
  const m = verdictMessage(d, "MERGE-POLICY.md");
  assert.ok(m.startsWith("Merge Policy Gate: held"));
  assert.ok(m.includes("§2.1 protected paths"));
  assert.ok(m.includes("rules=["));
});
