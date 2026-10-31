// Merge Policy Gate: one evaluator, three surfaces.
//   1. bitbucket:mergeCheck  -> run()            blocks or passes a pull request
//   2. Rovo agent actions    -> evaluatePullRequest(), explainRule(), policyTemplate(), lastVerdict()
//   3. rovo:mcp              -> the same actions exposed as tools to other agents
import { kvs } from "@forge/kvs";
import { parsePolicy, evaluate, verdictMessage, classifyDependencyDiff, findJiraKey, RULES, DEFAULT_POLICY } from "./policy.js";
import { getPullRequest, getDiffstat, getFileAt, summarize } from "./bitbucket.js";

const POLICY_PATH = "MERGE-POLICY.md";

/** Evaluate a pull request end to end. Returns { decision, facts, policySource, message }. */
export async function evaluatePR(workspace, repo, prId, opts = {}) {
  const pr = await getPullRequest(workspace, repo, prId);
  const diffstat = await getDiffstat(workspace, repo, prId);
  const facts = summarize(pr, diffstat);
  // Verdicts are keyed by the repository's slug path (workspace/repo), which is stable whether the caller
  // passed UUIDs (the merge-check event) or slugs (the agent, the MCP tools, the verdict feed).
  const fullName = String(pr.destination?.repository?.full_name || `${decodeURIComponent(workspace)}/${decodeURIComponent(repo)}`).toLowerCase();

  // The policy is read from the destination branch, so a pull request cannot loosen the rules it is judged by.
  const policyText = facts.destinationCommit ? await getFileAt(workspace, repo, facts.destinationCommit, POLICY_PATH) : null;
  const { policy, source } = parsePolicy(policyText);

  // Dependency bumps: compare each dependency file between destination and source commits.
  const depChanges = [];
  for (const f of facts.changedFiles) {
    if (!(policy.dependency_files || []).includes(f)) continue;
    const [oldText, newText] = await Promise.all([
      facts.destinationCommit ? getFileAt(workspace, repo, facts.destinationCommit, f) : null,
      facts.sourceCommit ? getFileAt(workspace, repo, facts.sourceCommit, f) : null,
    ]);
    depChanges.push(...classifyDependencyDiff(oldText, newText, f));
  }

  // Linked Jira work item key from the branch name or the title. A Bitbucket-scoped Forge app cannot also
  // hold Jira site scopes, so the status check (jira_allowed_statuses) runs only when a status is supplied
  // by the caller (the MCP tool, the agent action and the verdict feed accept `jiraStatus`; the Jira-side
  // explainer app reads it from the Teamwork Graph); the merge check itself enforces key presence (jira_required).
  const jiraKey = findJiraKey(facts.sourceBranch, facts.title);
  const jiraStatus = opts.jiraStatus ? String(opts.jiraStatus) : null;
  const jira = jiraKey ? { key: jiraKey, found: true, status: jiraStatus } : null;

  const decision = evaluate(policy, { ...facts, dependencyChanges: depChanges, jira });
  const message = verdictMessage(decision, source);
  const record = {
    workspace: fullName.split("/")[0],
    repo: fullName.split("/")[1],
    prId: Number(prId),
    title: facts.title,
    allowed: decision.allowed,
    violated: decision.violated,
    satisfied: decision.satisfied,
    reasons: decision.reasons,
    rules: decision.rules,
    policySource: source,
    facts: { changedFiles: facts.changedFiles.length, changedLines: facts.changedLines, approvalsByOthers: facts.approvalsByOthers, draft: facts.draft, jira },
    evaluatedAt: new Date().toISOString(),
  };
  await kvs.set(verdictKey(fullName, prId), record).catch((e) => console.error("verdict store failed", e));
  // Remember uuid -> slugs so the pull-request card (which only sees the repository UUID) can find this repo.
  const repoUuid = pr.destination?.repository?.uuid;
  if (repoUuid) {
    await kvs.set(`repo:${String(repoUuid).replace(/[{}]/g, "")}`, { fullName, workspace: fullName.split("/")[0], repo: fullName.split("/")[1] }).catch(() => {});
  }
  // Index by Jira key so "which pull requests of KAN-3 are held?" is one lookup (feed ?jira=KAN-3, the explainer
  // agent, Jira Automation). The index holds pointers only; the verdict record stays the single source of truth.
  if (jiraKey) await indexByJira(jiraKey, fullName, prId, record).catch((e) => console.error("jira index failed", e));
  return { decision, facts, policySource: source, message, record };
}

function jiraKeyIndex(key) {
  return `jira:${String(key).toUpperCase()}`;
}
async function indexByJira(key, fullName, prId, record) {
  const idx = (await kvs.get(jiraKeyIndex(key)).catch(() => null)) || { key: String(key).toUpperCase(), pullRequests: {} };
  idx.pullRequests[`${fullName}#${Number(prId)}`] = {
    workspace: fullName.split("/")[0],
    repo: fullName.split("/")[1],
    prId: Number(prId),
    title: record.title,
    allowed: record.allowed,
    violated: record.violated,
    evaluatedAt: record.evaluatedAt,
  };
  idx.updatedAt = record.evaluatedAt;
  await kvs.set(jiraKeyIndex(key), idx);
}

/** Every pull request the gate has evaluated for a Jira work item, newest first, with its stored verdict. */
export async function pullRequestsForJira(key) {
  const idx = await kvs.get(jiraKeyIndex(key)).catch(() => null);
  if (!idx) return { key: String(key).toUpperCase(), pullRequests: [] };
  const entries = Object.values(idx.pullRequests || {}).sort((a, b) => String(b.evaluatedAt).localeCompare(String(a.evaluatedAt)));
  const pullRequests = [];
  for (const e of entries) {
    const rec = await kvs.get(verdictKey(`${e.workspace}/${e.repo}`, e.prId)).catch(() => null);
    pullRequests.push(rec || e);
  }
  return { key: idx.key, updatedAt: idx.updatedAt, pullRequests };
}

// Forge KVS keys allow letters, digits, ':', '.', '_', '-', '#' and spaces (no '/'), so the slug path is joined with ':'.
function verdictKey(fullName, prId) {
  return `verdict:${String(fullName).toLowerCase().replace("/", ":")}:${Number(prId)}`;
}
function slugKey(workspace, repository, prId) {
  return verdictKey(`${decodeURIComponent(String(workspace || ""))}/${decodeURIComponent(String(repository || ""))}`, prId);
}

// ---- 1. merge check ------------------------------------------------------------------------

export async function run(event) {
  const workspace = event.workspace?.uuid;
  const repo = event.repository?.uuid;
  const prId = event.pullrequest?.id;
  try {
    const { decision, message } = await evaluatePR(workspace, repo, prId);
    return { success: decision.allowed, message: trim(message) };
  } catch (e) {
    // A failed check is treated as a block by Bitbucket; say why instead of failing silently.
    console.error("merge check error", e);
    return { success: false, message: trim(`Merge Policy Gate: could not evaluate (${String(e.message || e)}). rules=[§5.1]`) };
  }
}

function trim(s) {
  return s.length > 1800 ? `${s.slice(0, 1790)}…` : s;
}

// ---- 2 & 3. agent actions / MCP tools -------------------------------------------------------

/** Action: evaluate a pull request now. Inputs may be UUIDs or slugs (Bitbucket accepts both). */
export async function evaluatePullRequest(payload) {
  const { workspace, repository, pullRequestId } = payload;
  if (!workspace || !repository || !pullRequestId) {
    return "I need the workspace, the repository and the pull request number, for example workspace acme, repository shop, pull request 42.";
  }
  const ws = encodeURIComponent(workspace);
  const rp = encodeURIComponent(repository);
  try {
    const { record } = await evaluatePR(ws, rp, pullRequestId, { jiraStatus: payload.jiraStatus });
    return {
      verdict: record.allowed ? "pass" : "held",
      pullRequest: `${workspace}/${repository}#${pullRequestId}`,
      title: record.title,
      reasons: record.reasons,
      rulesCited: record.rules,
      policySource: record.policySource,
      facts: record.facts,
      howToUnblock: record.allowed ? [] : record.violated.map(unblockHint),
    };
  } catch (e) {
    return `I could not evaluate ${workspace}/${repository}#${pullRequestId}: ${String(e.message || e)}. The app must be installed on that Bitbucket workspace and the repository must exist.`;
  }
}

/** Action: the last stored verdict (what the merge check decided most recently). */
export async function lastVerdict(payload) {
  const { workspace, repository, pullRequestId } = payload;
  const rec = await kvs.get(slugKey(workspace, repository, pullRequestId));
  if (!rec) return `No stored verdict for ${workspace}/${repository}#${pullRequestId}. Ask me to evaluate it now.`;
  return rec;
}

/** Action: explain one rule in plain words. */
export async function explainRule(payload) {
  const id = normalizeRuleId(payload.ruleId);
  const text = RULES[id];
  if (!text) return { known: Object.keys(RULES), message: `I do not know rule ${payload.ruleId}.` };
  return { rule: id, text, unblock: unblockHint(id) };
}

/** Action: the starter MERGE-POLICY.md a repository can commit. */
export async function policyTemplate() {
  return { path: POLICY_PATH, content: policyTemplateText(), defaults: DEFAULT_POLICY };
}

function normalizeRuleId(s) {
  const m = /(\d+)\.(\d+)/.exec(String(s || ""));
  return m ? `§${m[1]}.${m[2]}` : String(s || "");
}

function unblockHint(rule) {
  switch (rule) {
    case "§2.1":
      return "Ask a reviewer who is not the author to approve the pull request, or move the change to the protected file into its own reviewed pull request.";
    case "§2.2":
      return "Get a reviewer's approval for the major bump or the added/removed package, or split it from the rest of the change.";
    case "§3.4":
      return "Split the pull request so each part stays under the size limits, or raise the limits in MERGE-POLICY.md on the destination branch.";
    case "§3.5":
      return "Mark the pull request as ready for review (not a draft).";
    case "§4.1":
      return "Put the Jira key in the branch name or title and move the work item to an allowed status, or adjust jira_allowed_statuses in MERGE-POLICY.md.";
    default:
      return "See MERGE-POLICY.md on the destination branch.";
  }
}

export function policyTemplateText() {
  return `# Merge policy

This file is read by Merge Policy Gate from the destination branch of every pull request.
Edit the block below; the prose above it is for people. Each verdict cites the rule numbers it relied on.

- §2.1 Protected paths are never merged without a human approval.
- §2.2 Dependency files may change automatically only for patch or minor bumps.
- §3.4 Size limits keep automatic merges reviewable.
- §3.5 Drafts do not merge.
- §3.6 A human approval is an Approved review from someone other than the author.
- §4.1 The linked Jira work item must be in an allowed status.

\`\`\`yaml merge-policy
protected_paths: ["Dockerfile", ".dockerignore", "bitbucket-pipelines.yml", ".github/**", "MERGE-POLICY.md", "LICENSE"]
dependency_files: ["requirements.txt", "requirements-dev.txt", "pyproject.toml", "package.json"]
dependency_bumps:
  auto: ["patch", "minor"]
  human: ["major", "add", "remove"]
limits:
  max_changed_lines: 400
  max_changed_files: 20
block_drafts: true
human_approvals_required: 1
jira_allowed_statuses: []   # statuses checked by the MCP tool when a status is supplied
jira_required: false
\`\`\`
`;
}

// ---- 4. web trigger: verdict feed for the Jira-side explainer app --------------------------
// GET ?workspace=..&repository=..&pr=..[&live=1][&jiraStatus=..]  -> stored verdict, or a fresh evaluation with live=1
// GET ?jira=KAN-3                                                 -> every evaluated pull request of that work item
// The verdict is already visible to everyone who can see the pull request, so this endpoint carries no
// secret; it only ever reads. Unknown pull requests return 404.
export async function verdictFeed(request) {
  const q = request.queryParameters || {};
  const jiraKey = first(q.jira);
  if (jiraKey) {
    if (!/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(String(jiraKey).toUpperCase())) return json(400, { error: "jira must be a work item key like KAN-3" });
    return json(200, await pullRequestsForJira(jiraKey));
  }
  const workspace = first(q.workspace);
  const repository = first(q.repository);
  const prId = first(q.pr);
  const live = first(q.live) === "1";
  if (!workspace || !repository || !prId) {
    return json(400, { error: "workspace, repository and pr are required (or jira=KEY)" });
  }
  try {
    if (live) {
      const { record } = await evaluatePR(encodeURIComponent(workspace), encodeURIComponent(repository), prId, { jiraStatus: first(q.jiraStatus) });
      return json(200, record);
    }
    const rec = await kvs.get(slugKey(workspace, repository, prId));
    return rec ? json(200, rec) : json(404, { error: "no stored verdict; call with live=1 to evaluate now" });
  } catch (e) {
    return json(502, { error: String(e.message || e) });
  }
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}
function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": ["application/json"] }, body: JSON.stringify(body) };
}
