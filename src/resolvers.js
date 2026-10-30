// Resolver behind the UI Kit surfaces (pull-request card, repository settings page).
// Everything here reuses the same evaluator and the same stored verdicts as the merge check and the agent.
import { makeResolver } from "@forge/resolver";
import api, { route } from "@forge/api";
import { kvs } from "@forge/kvs";
import { evaluatePR, policyTemplateText } from "./index.js";
import { RULES, parsePolicy } from "./policy.js";


function repoKey(uuid) {
  return `repo:${String(uuid).replace(/[{}]/g, "")}`;
}
function verdictKey(fullName, prId) {
  return `verdict:${String(fullName).toLowerCase().replace("/", ":")}:${Number(prId)}`;
}

/** Map a repository UUID (all the card context gives us) to workspace/repo slugs. */
async function resolveRepo(repoUuid, workspace, repo) {
  if (workspace && repo) {
    const rec = { fullName: `${workspace}/${repo}`.toLowerCase(), workspace, repo };
    if (repoUuid) await kvs.set(repoKey(repoUuid), rec).catch(() => {});
    return rec;
  }
  if (!repoUuid) return null;
  const cached = await kvs.get(repoKey(repoUuid)).catch(() => null);
  if (cached?.fullName) return cached;
  // Fallback: probe the workspaces the app can see. Normally exactly one.
  const ws = await api.asApp().requestBitbucket(route`/2.0/workspaces?pagelen=50`).then((r) => (r.ok ? r.json() : { values: [] }));
  for (const w of ws.values || []) {
    const r = await api.asApp().requestBitbucket(route`/2.0/repositories/${w.slug}/${repoUuid}`);
    if (r.ok) {
      const repo = await r.json();
      const rec = { fullName: String(repo.full_name).toLowerCase(), workspace: w.slug, repo: repo.slug };
      await kvs.set(repoKey(repoUuid), rec).catch(() => {});
      return rec;
    }
  }
  return null;
}

function unblockHint(rule) {
  switch (rule) {
    case "§2.1": return "Ask a reviewer who is not the author to approve, or move the protected-file change into its own reviewed pull request.";
    case "§2.2": return "Get a reviewer's approval for the major bump / added or removed package, or split it from the rest of the change.";
    case "§3.4": return "Split the pull request so each part stays under the size limits, or raise the limits in MERGE-POLICY.md on the destination branch.";
    case "§3.5": return "Mark the pull request as ready for review (not a draft).";
    case "§4.1": return "Put the Jira key in the branch name or title, or adjust jira_required in MERGE-POLICY.md.";
    default: return "See MERGE-POLICY.md on the destination branch.";
  }
}

function shape(rec) {
  if (!rec) return null;
  const rows = (rec.rules || []).map((rule) => ({
    rule,
    text: RULES[rule] || "",
    status: (rec.violated || []).includes(rule) ? "held" : (rec.satisfied || []).includes(rule) ? "ok" : "evaluated",
    reason: (rec.reasons || []).find((r) => String(r).startsWith(rule)) || "",
    unblock: (rec.violated || []).includes(rule) ? unblockHint(rule) : "",
  }));
  return { ...rec, rows };
}

const definitions = {
  async getVerdict({ payload }) {
  const { repoUuid, prId } = payload;
  const repo = await resolveRepo(repoUuid, payload.workspace, payload.repo);
  if (!repo) return { state: "unknown-repo" };
  const rec = await kvs.get(verdictKey(repo.fullName, prId)).catch(() => null);
  return { state: rec ? "stored" : "none", repo, record: shape(rec) };
  },

  async evaluateNow({ payload }) {
  const { repoUuid, prId } = payload;
  const repo = await resolveRepo(repoUuid, payload.workspace, payload.repo);
  if (!repo) return { state: "unknown-repo" };
  try {
    const { record } = await evaluatePR(encodeURIComponent(repo.workspace), encodeURIComponent(repo.repo), prId);
    return { state: "fresh", repo, record: shape(record) };
  } catch (e) {
    return { state: "error", repo, error: String(e.message || e) };
  }
  },

  /** Settings page: is MERGE-POLICY.md on the default branch, does it parse, what does it say. */
  async getPolicyStatus({ payload }) {
  const repo = await resolveRepo(payload.repoUuid, payload.workspace, payload.repo);
  if (!repo) return { state: "unknown-repo" };
  const meta = await api.asApp().requestBitbucket(route`/2.0/repositories/${repo.workspace}/${repo.repo}`).then((r) => (r.ok ? r.json() : null));
  const branch = meta?.mainbranch?.name || "main";
  const res = await api.asApp().requestBitbucket(route`/2.0/repositories/${repo.workspace}/${repo.repo}/src/${branch}/MERGE-POLICY.md`);
  const text = res.status === 404 ? null : res.ok ? await res.text() : null;
  const { policy, source } = parsePolicy(text);
  return { state: "ok", repo, branch, found: text !== null, source, policy, template: policyTemplateText() };
  },
};

export const handler = makeResolver(definitions);
