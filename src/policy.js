// Pure policy evaluator. No Forge imports here so it can be unit-tested with plain Node.
//
// A repository opts in by committing MERGE-POLICY.md with a fenced block:
//
//   ```yaml merge-policy
//   protected_paths: ["Dockerfile", ".github/**"]
//   ...
//   ```
//
// The YAML subset we parse is deliberately small (scalars, lists, one level of nesting), so the
// app ships without a YAML dependency and a policy file can never pull in arbitrary code.

export const DEFAULT_POLICY = Object.freeze({
  version: 1,
  // §2.1 paths that are never merged without a human approval
  protected_paths: [
    "Dockerfile",
    ".dockerignore",
    "bitbucket-pipelines.yml",
    ".github/**",
    "MERGE-POLICY.md",
    "LICENSE",
  ],
  // §2.2 dependency files and which bump kinds need a human
  dependency_files: ["requirements.txt", "requirements-dev.txt", "pyproject.toml", "package.json"],
  dependency_bumps: { auto: ["patch", "minor"], human: ["major", "add", "remove"] },
  // §3.4 size limits
  limits: { max_changed_lines: 400, max_changed_files: 20 },
  // §3.5 draft pull requests never pass
  block_drafts: true,
  // §3.6 approvals: how many non-author approvals count as "a human signed off"
  human_approvals_required: 1,
  // §4.1 linked Jira work item: statuses in which a change may merge; empty list disables the rule
  jira_allowed_statuses: [],
  jira_required: false,
});

const BLOCK_RE = /```yaml\s+merge-policy\s*\n([\s\S]*?)```/;

/** Parse the fenced policy block out of MERGE-POLICY.md. Returns DEFAULT_POLICY when absent. */
export function parsePolicy(markdown) {
  if (!markdown) return { policy: DEFAULT_POLICY, source: "default" };
  const m = BLOCK_RE.exec(markdown);
  if (!m) return { policy: DEFAULT_POLICY, source: "default" };
  const parsed = parseMiniYaml(m[1]);
  const policy = { ...DEFAULT_POLICY, ...parsed };
  policy.limits = { ...DEFAULT_POLICY.limits, ...(parsed.limits || {}) };
  policy.dependency_bumps = { ...DEFAULT_POLICY.dependency_bumps, ...(parsed.dependency_bumps || {}) };
  return { policy, source: "MERGE-POLICY.md" };
}

/**
 * Minimal YAML reader for the policy block: `key: value`, `key: [a, b]`, `key:` followed by
 * `  - item` lines, and `key:` followed by two-space indented `sub: value` lines.
 * Strings may be quoted; numbers and booleans are converted; `#` starts a comment.
 */
export function parseMiniYaml(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = stripComment(lines[i]);
    i += 1;
    if (!raw.trim()) continue;
    if (/^\s/.test(raw)) continue; // stray indented line without a parent
    const mm = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(raw);
    if (!mm) continue;
    const key = mm[1];
    const rest = mm[2];
    if (rest !== "") {
      out[key] = parseScalarOrList(rest);
      continue;
    }
    // Nested block: either a list of "- item" or a map of "sub: value".
    const list = [];
    const map = {};
    let isList = null;
    while (i < lines.length && (/^\s+/.test(lines[i]) || !stripComment(lines[i]).trim())) {
      const sub = stripComment(lines[i]);
      i += 1;
      if (!sub.trim()) continue;
      const li = /^\s+-\s*(.*)$/.exec(sub);
      if (li) {
        isList = true;
        list.push(parseScalar(li[1]));
        continue;
      }
      const kv = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(sub);
      if (kv) {
        isList = false;
        map[kv[1]] = parseScalarOrList(kv[2]);
      }
    }
    out[key] = isList ? list : map;
  }
  return out;
}

function stripComment(line) {
  // Remove "# comment" that is not inside quotes.
  let inQ = null;
  for (let k = 0; k < line.length; k += 1) {
    const c = line[k];
    if (inQ) {
      if (c === inQ) inQ = null;
    } else if (c === '"' || c === "'") {
      inQ = c;
    } else if (c === "#" && (k === 0 || /\s/.test(line[k - 1]))) {
      return line.slice(0, k);
    }
  }
  return line;
}

function parseScalarOrList(text) {
  const t = text.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map(parseScalar);
  }
  return parseScalar(t);
}

function splitTopLevel(s) {
  const parts = [];
  let cur = "";
  let inQ = null;
  for (const c of s) {
    if (inQ) {
      cur += c;
      if (c === inQ) inQ = null;
    } else if (c === '"' || c === "'") {
      inQ = c;
      cur += c;
    } else if (c === ",") {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function parseScalar(text) {
  const t = text.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/** Glob-ish path match: `dir/**`, `*.ext`, exact paths. */
export function pathMatches(path, patterns) {
  for (const pat of patterns || []) {
    if (typeof pat !== "string") continue;
    if (pat.endsWith("/**")) {
      if (path.startsWith(pat.slice(0, -3) + "/")) return true;
    } else if (pat === path) {
      return true;
    } else if (globToRegex(pat).test(path)) {
      return true;
    }
  }
  return false;
}

function globToRegex(glob) {
  let re = "";
  for (const c of glob) {
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// ---- dependency bumps ---------------------------------------------------------------------

const PIN_LINE = /^\s*([A-Za-z0-9_.\-\[\]]+)\s*==\s*([0-9][^\s;#]*)/;

/** Return [{ package, kind }] with kind in patch | minor | major | add | remove. */
export function classifyDependencyDiff(oldText, newText, fileName = "requirements.txt") {
  const oldMap = pins(oldText, fileName);
  const newMap = pins(newText, fileName);
  const names = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);
  const out = [];
  for (const name of [...names].sort()) {
    if (!(name in oldMap)) out.push({ package: name, kind: "add" });
    else if (!(name in newMap)) out.push({ package: name, kind: "remove" });
    else if (oldMap[name] !== newMap[name]) out.push({ package: name, kind: bumpKind(oldMap[name], newMap[name]) });
  }
  return out;
}

function pins(text, fileName) {
  const map = {};
  if (!text) return map;
  if (fileName.endsWith("package.json")) {
    try {
      const j = JSON.parse(text);
      for (const section of ["dependencies", "devDependencies"]) {
        for (const [k, v] of Object.entries(j[section] || {})) map[k.toLowerCase()] = String(v);
      }
    } catch {
      // unparsable JSON: treat as no pins; the size rules still apply
    }
    return map;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = PIN_LINE.exec(line);
    if (m) map[m[1].toLowerCase()] = m[2];
  }
  return map;
}

export function bumpKind(oldV, newV) {
  const nums = (v) => (String(v).match(/\d+/g) || []).slice(0, 3).map(Number).concat([0, 0, 0]);
  const o = nums(oldV);
  const n = nums(newV);
  if (n[0] !== o[0]) return "major";
  if (n[1] !== o[1]) return "minor";
  return "patch";
}

// ---- rule texts (the agent cites these) ---------------------------------------------------

export const RULES = Object.freeze({
  "§2.1": "Protected paths (CI config, Dockerfiles, the policy itself) are never merged without a human approval.",
  "§2.2": "Dependency files may change automatically only for patch or minor bumps; major bumps, added and removed packages need a human approval.",
  "§3.4": "Size limits: at most max_changed_lines changed lines and max_changed_files changed files.",
  "§3.5": "Draft pull requests do not merge.",
  "§3.6": "A human approval is an Approved review from someone other than the author.",
  "§4.1": "The linked Jira work item (key in the branch name or title) must be in an allowed status.",
  "§5.1": "Every verdict cites the rules it relied on, so a reviewer can see why the gate decided.",
});

/**
 * Evaluate one pull request against a policy.
 *
 * facts = {
 *   changedFiles: string[], changedLines: number, draft: boolean,
 *   approvalsByOthers: number, dependencyChanges: [{package, kind}],
 *   jira: { key, status, found } | null
 * }
 */
export function evaluate(policy, facts) {
  const d = { allowed: true, violated: [], satisfied: [], reasons: [] };
  const humanOk = (facts.approvalsByOthers || 0) >= (policy.human_approvals_required ?? 1);

  const protectedHits = (facts.changedFiles || []).filter((f) => pathMatches(f, policy.protected_paths));
  if (protectedHits.length && !humanOk) {
    block(d, "§2.1", `§2.1 protected paths changed without a human approval: ${protectedHits.sort().join(", ")}`);
  } else if (protectedHits.length) {
    ok(d, "§2.1", `§2.1 protected paths changed (${protectedHits.length}) but a human approval is present`);
  } else {
    ok(d, "§2.1");
  }

  const humanKinds = new Set(policy.dependency_bumps?.human || []);
  const badBumps = (facts.dependencyChanges || []).filter((c) => humanKinds.has(c.kind));
  if (badBumps.length && !humanOk) {
    block(d, "§2.2", `§2.2 dependency changes need a human approval: ${badBumps.map((c) => `${c.package} (${c.kind})`).join(", ")}`);
  } else if (badBumps.length) {
    ok(d, "§2.2", `§2.2 dependency changes present but a human approval is present`);
  } else {
    ok(d, "§2.2");
  }

  const lim = policy.limits || {};
  const files = (facts.changedFiles || []).length;
  const lines = facts.changedLines || 0;
  if (lines > lim.max_changed_lines || files > lim.max_changed_files) {
    block(d, "§3.4", `§3.4 size limit exceeded: ${lines} lines / ${files} files (max ${lim.max_changed_lines} / ${lim.max_changed_files})`);
  } else {
    ok(d, "§3.4");
  }

  if (policy.block_drafts && facts.draft) {
    block(d, "§3.5", "§3.5 pull request is a draft");
  } else {
    ok(d, "§3.5");
  }

  if (humanOk) ok(d, "§3.6", `§3.6 ${facts.approvalsByOthers} approval(s) from reviewers other than the author`);

  const allowed = policy.jira_allowed_statuses || [];
  const j = facts.jira;
  if (policy.jira_required || allowed.length) {
    if (!j || !j.key) {
      if (policy.jira_required) block(d, "§4.1", "§4.1 no Jira work item key in the branch name or title");
      else ok(d, "§4.1", "§4.1 no linked Jira work item (not required by this policy)");
    } else if (!allowed.length || j.status == null) {
      ok(d, "§4.1", `§4.1 linked work item ${j.key}` + (allowed.length ? " (status not checked here)" : ""));
    } else if (!j.found) {
      block(d, "§4.1", `§4.1 linked work item ${j.key} could not be read in Jira`);
    } else if (!allowed.map(norm).includes(norm(j.status))) {
      block(d, "§4.1", `§4.1 ${j.key} is "${j.status}"; allowed: ${allowed.join(", ")}`);
    } else {
      ok(d, "§4.1", `§4.1 ${j.key} is "${j.status}"`);
    }
  }

  if (d.allowed) d.reasons.push("all policy rules satisfied");
  d.rules = [...new Set([...d.violated, ...d.satisfied])].sort();
  return d;
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}
function block(d, rule, reason) {
  d.allowed = false;
  d.violated.push(rule);
  d.reasons.push(reason);
}
function ok(d, rule, reason) {
  d.satisfied.push(rule);
  if (reason) d.reasons.push(reason);
}

/** Short message for the Bitbucket merge-check card (Bitbucket shows one line prominently). */
export function verdictMessage(d, source) {
  const head = d.allowed ? "Merge Policy Gate: pass" : "Merge Policy Gate: held";
  const body = d.allowed ? d.reasons.filter((r) => !r.startsWith("all policy")) : d.reasons.filter((r) => d.violated.some((v) => r.startsWith(v)));
  const cite = `rules=[${d.rules.join(", ")}] policy=${source}`;
  return [head, ...body, cite].join(" · ");
}

/** Find a Jira work item key (PROJ-123) in a branch name or title. */
export function findJiraKey(...texts) {
  for (const t of texts) {
    // Jira keys are upper case; the text is not upper-cased so "sha256-12" style fragments do not match.
    const m = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,9}-\d+)(?!\d)/.exec(String(t || ""));
    if (m) return m[1];
  }
  return null;
}
