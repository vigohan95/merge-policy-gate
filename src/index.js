// Merge Policy Gate: one evaluator, three surfaces.
//   1. bitbucket:mergeCheck  -> run()            blocks or passes a pull request
//   2. Rovo agent actions    -> evaluatePullRequest(), explainRule(), policyTemplate(), lastVerdict()
//   3. rovo:mcp              -> the same actions exposed as tools to other agents
import { kvs } from "@forge/kvs";
import { parsePolicy, evaluate, verdictMessage, classifyDependencyDiff, findJiraKey, RULES, DEFAULT_POLICY } from "./policy.js";
import { getPullRequest, getDiffstat, getFileAt, summarize } from "./bitbucket.js";

const POLICY_PATH = "MERGE-POLICY.md";

/** Evaluate a pull request end to end. Returns { decision, facts, policySource, message }. */
export async function evaluatePR(workspace, repo, prId) {
  const pr = await getPullRequest(workspace, repo, prId);
  const diffstat = await getDiffstat(workspace, repo, prId);
  const facts = summarize(pr, diffstat);

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
  // by the caller (the MCP tool accepts one); the merge check itself enforces key presence (jira_required).
  const jiraKey = findJiraKey(facts.sourceBranch, facts.title);
  const jira = jiraKey ? { key: jiraKey, found: true, status: null } : null;

  const decision = evaluate(policy, { ...facts, dependencyChanges: depChanges, jira });
  const message = verdictMessage(decision, source);
  const record = {
    workspace,
    repo,
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
  await kvs.set(verdictKey(workspace, repo, prId), record).catch(() => {});
  return { decision, facts, policySource: source, message, record };
}

function verdictKey(workspace, repo, prId) {
  return `verdict:${workspace}:${repo}:${prId}`;
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
    const { record } = await evaluatePR(ws, rp, pullRequestId);
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
  const rec = await kvs.get(verdictKey(encodeURIComponent(workspace || ""), encodeURIComponent(repository || ""), pullRequestId));
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
