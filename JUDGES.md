# Judge guide: Merge Policy Gate + Merge Gate Explainer

Two Forge apps, one evaluator. **Merge Policy Gate** is a Bitbucket Cloud custom merge check that reads `MERGE-POLICY.md`
from the destination branch and decides *pass* or *held*, citing rule numbers. **Merge Gate Explainer** is the Jira-side
Rovo agent that reads those verdicts, enriches them with the Teamwork Graph, and tells a developer or release manager
exactly what to do next. The split exists because a Forge app holds either Bitbucket workspace scopes or Jira site
scopes, never both.

Everything below was exercised on 2026-10-29 to 10-31 against the public demo repository
https://bitbucket.org/hanvigo-dev/gate-demo and a Forge demo Jira site. Evidence files are listed at the end.

## 10-minute path (no installation)

1. Open https://bitbucket.org/hanvigo-dev/gate-demo/pull-requests/2 . The merge-checks card shows **held** with
   `§2.1 protected paths changed without a human approval: Dockerfile` and `§2.2 dependency changes need a human
   approval: httpx (major)`. The *Merge Policy Gate* card in the right sidebar lists each rule with HELD/OK, the reason,
   and the unblock step, plus facts (files, lines, approvals by others, Jira key) and the policy source.
2. Open pull request 3 (`feature/KAN-3-fixtures`, 520 lines): held under `§3.4 size limit exceeded: 520 lines / 1 files
   (max 400 / 20)`.
3. Open pull request 1 (merged): evaluated on merge, `allowed`, rules `§2.1 §2.2 §3.4 §3.5`.
4. Read https://bitbucket.org/hanvigo-dev/gate-demo/src/main/MERGE-POLICY.md : the YAML block is the whole policy. A pull
   request cannot loosen it because the gate reads the **destination** branch.
5. Read a verdict as JSON from the feed the Explainer uses (production web trigger, read-only, URL in the Devpost
   submission): `?workspace=hanvigo-dev&repository=gate-demo&pr=2`, or `?jira=KAN-3` for every evaluated pull request
   of a work item.

## Install it yourself (about 15 minutes)

Both apps are shared from the production environment; the installation links are on the Devpost submission page
(Distribution → Sharing links from the developer console).

### Merge Policy Gate (Bitbucket)

1. Use a **non-personal** Bitbucket workspace where you are admin (Forge apps cannot be installed on personal
   workspaces). Workspace settings → **Custom merge checks** must be enabled by a workspace admin.
2. Open the installation link, pick the workspace, accept scopes `read:pullrequest:bitbucket`,
   `read:repository:bitbucket`, `storage:app`. The app never writes to the repository.
3. In a repository: **Repository settings → Merge checks → Custom merge checks** → enable *Merge Policy Gate*. On
   Premium you can mark it *Required*; on Free and Standard it is advisory and still shows every verdict.
4. **Repository settings → Forge apps → Merge Policy Gate** opens the settings page: whether `MERGE-POLICY.md` exists on
   the default branch, the parsed rules, the starter file (copy it), and a *Dry-run* button per open pull request.
5. Commit the starter `MERGE-POLICY.md` to the default branch (the settings page shows it; the agent and the MCP tool
   return it too), then push any pull request. The verdict appears in the merge-checks card within ~20 s and in the
   *Merge Policy Gate* sidebar card.

Quick checks to try:

| Change | Expected verdict |
|---|---|
| touch `Dockerfile` or `bitbucket-pipelines.yml` without a second reviewer | held `§2.1` |
| bump a dependency's major version in `requirements.txt` / `package.json` | held `§2.2`; patch/minor passes |
| more than 400 changed lines or 20 files | held `§3.4` |
| mark the pull request as draft | held `§3.5` |
| a reviewer other than the author approves | the check re-runs on the review event; `§2.1`/`§2.2` release without a push |
| set `jira_required: true` and push a branch without a key | held `§4.1` |

### Merge Gate Explainer (Jira + Rovo)

1. Open the installation link, pick a Jira site with Rovo enabled. Scopes: `storage:app`, `read:jira-work`, and the
   read-only Teamwork Graph scopes `read:graph:issue:jira`, `read:graph:issue-status:jira`,
   `read:graph:pull-request:external`, `read:graph:user:atlassian`.
2. Open Rovo chat, change agent → **Merge Gate Explainer**.
3. First message: `Connect this site to the Merge Policy Gate. The verdict feed URL is <feed URL>` (the URL from the
   Devpost page, or `forge webtrigger list -e production` in your own gate installation). Confirm the UPDATE action.
4. Ask:
   - `Why is pull request 2 in hanvigo-dev/gate-demo held?` → live evaluation, rules, unblock steps.
   - `Which pull requests of KAN-3 are held, and why?` → work item status from the Teamwork Graph, the gate's verdicts
     for every pull request carrying that key, re-checked against the current status (rule §4.1).
   - `What does rule 2.2 mean?` / `Give me a starter MERGE-POLICY.md` → the *adopt-merge-policy* skill.
5. Optional: the Jira Automation template in `merge-gate-explainer/docs/AUTOMATION.md` comments on a work item when it
   is moved to a ready status while a pull request is still held (one *Send web request* to the feed, no code).

### MCP (coding agents)

The gate also exposes `evaluate-pull-request`, `last-verdict`, `explain-rule`, `policy-template` through `rovo:mcp`.
With the app installed and external exposure enabled by the site admin (Admin → Connected apps → tools):

```
claude mcp add --transport http merge-policy-gate https://mcp.atlassian.com/forge/d6c929d9-996c-4661-a715-c6dc155b06e3
```

Then ask the coding agent to evaluate a pull request before it opens or merges one. The verdict JSON is identical to
what the merge check stores.

## What is deliberately out of scope

- Required (blocking) checks on Free/Standard workspaces: a Bitbucket plan limit, stated on screen.
- Writing to Bitbucket or Jira: the gate only reads; the Explainer only reads; the Automation template comments through
  Jira's own action.
- A second workspace user for the §3.6 approval-release drill is not available on our demo workspace; the code path is
  the `avi:bitbucket:reviewer-status-changed` trigger shown in `manifest.yml` and exercised by the unit tests.

## Evidence

- `docs/DRILL-2026-10-29.md`: first live drill (PR 2 held §2.1/§2.2, PR 1 pass).
- `../merge-gate-explainer/docs/AUTOMATION.md`: Automation template and feed reference.
- Devpost gallery: screenshots of the merge-checks card, the sidebar card, the settings page with dry-run, the Rovo
  conversation on the demo site (connect, explain PR 2, KAN-3 via Teamwork Graph), and the MCP call from Claude Code.
- Tests: `npm test` in `merge-policy-gate` (policy parser, every rule, dependency classification, Jira key detection).
