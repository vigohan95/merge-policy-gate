# Privacy policy — Merge Policy Gate

Last updated: 2026-10-31. Developer: Han Vigo (hanwg666@gmail.com).

Merge Policy Gate is a Forge app that runs entirely on Atlassian's Forge platform. It evaluates Bitbucket Cloud pull
requests against the repository's `MERGE-POLICY.md` and reports a verdict.

## What the app reads

With the scopes `read:pullrequest:bitbucket` and `read:repository:bitbucket` the app reads, for the pull request being
evaluated: its title, source and destination branches and commits, draft flag, reviewer approval states, the list of
changed files with line counts, and the contents of `MERGE-POLICY.md` and of dependency manifest files on the two
commits. It never writes to a repository.

## What the app stores

In Forge hosted storage (`storage:app`, data stays inside Atlassian's infrastructure, per installation):

- one verdict record per evaluated pull request: workspace and repository slug, pull request number and title, the
  rules cited, the reasons, counts of changed files and lines, the number of approvals by reviewers other than the
  author, the draft flag, the Jira key found in the branch or title, the policy source and a timestamp;
- a mapping from repository UUID to repository slug;
- an index from Jira work item key to the pull requests above.

No account IDs, names, e-mail addresses or other personal data are stored. Records are overwritten on each
re-evaluation and removed when the app is uninstalled (Forge storage is deleted with the installation).

## Who can see the data

The verdict is shown to anyone who can open the pull request. The app also exposes a read-only web trigger ("verdict
feed") that returns the same verdict record by workspace, repository and pull request number, or by Jira key, so that
the companion Jira app and Jira Automation rules can read it. It returns nothing that is not already visible on the
pull request page.

## Third parties and egress

The app makes no outbound calls to services outside Atlassian. It does not use analytics, tracking or advertising.

## Rovo agent and MCP tools

The agent actions and MCP tools return the same verdict records. Conversations with Rovo are handled by Atlassian
under the Atlassian terms; the app receives only the action inputs (workspace, repository, pull request number, rule
id).

## Contact

Questions or deletion requests: hanwg666@gmail.com, or open an issue at
https://github.com/vigohan95/merge-policy-gate/issues.
