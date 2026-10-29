// Thin wrappers over the Bitbucket Cloud REST API, called as the app.
// Scopes: read:pullrequest:bitbucket (pull request + diffstat), read:repository:bitbucket (file contents).
import api, { route } from "@forge/api";

async function getJson(r) {
  const res = await api.asApp().requestBitbucket(r);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Bitbucket ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function getPullRequest(workspace, repo, id) {
  return getJson(route`/2.0/repositories/${workspace}/${repo}/pullrequests/${id}`);
}

/** All diffstat pages: [{ status, lines_added, lines_removed, old: {path}, new: {path} }]. */
export async function getDiffstat(workspace, repo, id) {
  const values = [];
  let page = 1;
  for (;;) {
    const data = await getJson(route`/2.0/repositories/${workspace}/${repo}/pullrequests/${id}/diffstat?pagelen=100&page=${page}`);
    values.push(...(data.values || []));
    if (!data.next || page >= 20) break; // 2,000 files is far beyond any policy limit anyway
    page += 1;
  }
  return values;
}

/** Raw file content at a commit, or null when the file does not exist there. */
export async function getFileAt(workspace, repo, commit, path) {
  const res = await api.asApp().requestBitbucket(route`/2.0/repositories/${workspace}/${repo}/src/${commit}/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Bitbucket ${res.status} reading ${path}@${commit}`);
  return res.text();
}

/** Facts the policy needs, assembled from one pull request. */
export function summarize(pr, diffstat) {
  const changedFiles = [];
  let changedLines = 0;
  for (const entry of diffstat) {
    const path = entry.new?.path || entry.old?.path;
    if (path) changedFiles.push(path);
    changedLines += (entry.lines_added || 0) + (entry.lines_removed || 0);
  }
  const authorId = pr.author?.uuid || pr.author?.account_id;
  const approvalsByOthers = (pr.participants || []).filter((p) => {
    const id = p.user?.uuid || p.user?.account_id;
    return p.approved && id && id !== authorId;
  }).length;
  return {
    changedFiles,
    changedLines,
    draft: Boolean(pr.draft),
    approvalsByOthers,
    sourceCommit: pr.source?.commit?.hash,
    destinationCommit: pr.destination?.commit?.hash,
    sourceBranch: pr.source?.branch?.name,
    title: pr.title,
    state: pr.state,
  };
}
