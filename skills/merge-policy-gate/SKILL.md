---
name: merge-policy-gate
description: Check a Bitbucket Cloud pull request against the repository's MERGE-POLICY.md through the Merge Policy Gate MCP server before opening, updating or merging it. Use when an agent is about to push a branch, open a pull request, bump a dependency, touch CI or Docker files, or when a human asks why a pull request is held or what rule §2.1/§2.2/§3.4/§3.5/§4.1 means.
---

# Merge Policy Gate (MCP)

Merge Policy Gate is a Forge app on the Bitbucket workspace. It judges every pull request against `MERGE-POLICY.md` on
the **destination** branch and stores a verdict that cites rule numbers. The same evaluator is exposed as MCP tools
through Atlassian's Rovo MCP server, so a coding agent can ask *before* it wastes a push.

## Connect

The site admin enables external exposure for the app (Admin → Connected apps → tools). Then:

```
claude mcp add --transport http merge-policy-gate https://mcp.atlassian.com/forge/<app-id>
```

The app id is printed by `forge install list` or shown in the developer console; for the public demo it is
`d6c929d9-996c-4661-a715-c6dc155b06e3`. Authenticate with the Atlassian account that can see the workspace.

## Tools

| Tool | Inputs | Returns |
|---|---|---|
| `evaluate-pull-request` | `workspace`, `repository`, `pullRequestId`, optional `jiraStatus` | `verdict` (`pass`/`held`), `reasons[]`, `rulesCited[]`, `facts`, `howToUnblock[]`, `policySource` |
| `last-verdict` | `workspace`, `repository`, `pullRequestId` | the verdict the merge check stored at its last run |
| `explain-rule` | `ruleId` such as `2.2` | rule text and how to satisfy it |
| `policy-template` | optional `format` = `json` | the starter `MERGE-POLICY.md` or its defaults |

## Procedure for an agent that is about to change code

1. Before writing, call `policy-template` once per repository session, or read `MERGE-POLICY.md` from the destination
   branch if you have the checkout. Note `protected_paths`, `dependency_files`, `limits`, `jira_required`.
2. Plan the change so it stays inside the limits: keep under `max_changed_lines` / `max_changed_files`; do not touch
   protected paths in the same pull request as feature work; keep major dependency bumps in their own pull request.
3. Put the Jira key in the branch name (`feature/KAN-3-short-slug`) when `jira_required` is true.
4. After pushing and opening the pull request, call `evaluate-pull-request`. If `verdict` is `held`, follow
   `howToUnblock` in order (cheapest first: un-draft, add the key, split, then ask for a human approval). Re-run after
   each change; the gate re-evaluates on pushes and reviewer events as well.
5. Never try to satisfy a rule by editing `MERGE-POLICY.md` on your own branch. The gate reads the destination branch,
   so it has no effect, and it looks like an attempt to dodge review. Propose policy changes as a separate, reviewed
   pull request.

## Reading a verdict

- `reasons` strings begin with the rule number, for example `§2.2 dependency changes need a human approval: httpx
  (major)`. Quote them verbatim when reporting to a human.
- `facts.approvalsByOthers` counts *Approved* reviews from people other than the author; self-approval does not count.
- `policySource: default` means the repository has no policy file yet and the built-in defaults applied
  (400 lines / 20 files, drafts blocked, CI/Docker/policy paths protected, patch and minor bumps automatic).
- A `pass` from the tool is not a merge: on Free and Standard Bitbucket plans the check is advisory, and other checks
  (builds, required reviewers) still apply.

## Rule catalogue

| Rule | Meaning | Released by |
|---|---|---|
| §2.1 | protected paths need a human approval | approval by a non-author, or split |
| §2.2 | major bumps / added / removed packages need a human approval; patch and minor are automatic | approval, or split |
| §3.4 | size limits (lines, files) | split, or raise limits on the destination branch |
| §3.5 | drafts do not merge | mark ready for review |
| §3.6 | what counts as a human approval | more approvals by non-authors |
| §4.1 | Jira key required in branch or title; optional allowed statuses | add the key; transition the work item |
| §5.1 | every verdict cites its rules | informational |
