# Merge Policy Gate

A Bitbucket Cloud custom merge check that holds a pull request until the repository's written policy holds,
and says exactly which rule it relied on. One file in the repository, `MERGE-POLICY.md`, is the contract;
the gate reads it from the **destination** branch, so a pull request cannot loosen the rules it is judged by.

```
Merge Policy Gate: held · §2.1 protected paths changed without a human approval: Dockerfile ·
§2.2 dependency changes need a human approval: httpx (major) · rules=[§2.1, §2.2, §3.4, §3.5] policy=MERGE-POLICY.md
```

Built on Forge for Codegeist 2026. Companion app: **Merge Gate Explainer**, a Rovo agent for Jira that reads
this gate's verdicts and explains them in plain words (a Forge app cannot hold Bitbucket workspace scopes and
Jira site scopes at once, so the agent is a second app; see [docs/DRILL-2026-10-29.md](docs/DRILL-2026-10-29.md)).

## What the gate checks

| Rule | Meaning | Default |
|---|---|---|
| §2.1 | Protected paths need a human approval | `Dockerfile`, `.dockerignore`, `bitbucket-pipelines.yml`, `.github/**`, `MERGE-POLICY.md`, `LICENSE` |
| §2.2 | Dependency files may change automatically only for patch or minor bumps; major, added, removed need a human | `requirements*.txt`, `pyproject.toml`, `package.json` |
| §3.4 | Size limits | 400 changed lines, 20 files |
| §3.5 | Drafts do not merge | on |
| §3.6 | A human approval is an *Approved* review from someone other than the author | 1 required to release §2.1/§2.2 |
| §4.1 | A Jira work item key (`KAN-12`) in the branch name or title | optional (`jira_required: false`) |

Every verdict ends with `rules=[…]`, the list of rules that were evaluated, and names the policy source.

## Install in five minutes

1. A workspace admin enables **Workspace settings → Workflow → Custom merge checks**, then installs the app on the
   workspace (`forge install --product bitbucket` while the app is in development, or from the Marketplace listing).
2. In the repository: **Repository settings → Workflow → Custom merge checks → Add check → Merge Policy Gate**,
   pick the branches. Tick *Required* on Premium plans to make a `held` verdict block the merge button; on Free and
   Standard the verdict shows on the merge-checks card and in the pull request's checks list.
3. Commit `MERGE-POLICY.md` to the default branch. Start from the template below or ask the Rovo agent for it.
   Without the file the defaults above apply and the verdict says `policy=default`.

### MERGE-POLICY.md

````markdown
# Merge policy

- §2.1 Protected paths are never merged without a human approval.
- §2.2 Dependency files may change automatically only for patch or minor bumps.
- §3.4 Size limits keep automatic merges reviewable.
- §3.5 Drafts do not merge.

```yaml merge-policy
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
jira_allowed_statuses: []
jira_required: false
```
````

The block is parsed by a small, dependency-free YAML reader: scalars, inline lists, `- item` lists and one level
of `key: value` nesting. Nothing in the policy file is executed.

## Triggers

`on-code-pushed`, `on-reviewer-status-changed` (so an approval releases §2.1/§2.2 without a new push) and
`on-merge`. Bitbucket runs the check once per configured level and stores the result on the pull request.

## Agent and MCP

- **Actions** (`evaluate-pull-request`, `last-verdict`, `explain-rule`, `policy-template`) are exposed as
  **MCP tools** (`rovo:mcp`, server name *Merge Policy Gate*) so any Rovo Studio agent or MCP client can ask the gate
  a question. The same actions back the in-app `rovo:agent` module.
- **Verdict feed** (`webtrigger` `verdict-feed`): `GET …?workspace=<slug>&repository=<slug>&pr=<id>[&live=1]`
  returns the stored verdict, or evaluates now with `live=1`. The Jira-side Merge Gate Explainer reads this.
  Verdicts contain nothing that is not already visible on the pull request.

## Scopes

`read:pullrequest:bitbucket` (pull request, diffstat), `read:repository:bitbucket` (policy and dependency files
at the two commits), `storage:app` (last verdict per pull request). No write scopes: the gate never edits a
repository or a pull request.

## Development

```bash
npm install
npm test                 # node --test, pure evaluator tests
forge lint
forge deploy -e development
forge install --product bitbucket --site bitbucket.org/<workspace> -e development
forge webtrigger create -e development -f verdict-feed
```

`src/policy.js` is the evaluator (no Forge imports; unit-tested). `src/bitbucket.js` wraps the three REST calls.
`src/index.js` wires the merge check, the actions and the web trigger.

## Limits, honestly

- Verdicts are only *Required* on Premium; elsewhere they are advisory but visible.
- The Jira status of the linked work item is not checked by the merge check itself (scope split above). A key in
  the branch or title can be required; status rules apply when a status is supplied through the MCP tool.
- Dependency bumps are classified for pinned `==` lines and `package.json` `dependencies`/`devDependencies`;
  ranges are treated as text changes.
- The policy is read from the destination branch's head commit at evaluation time.

MIT License.
