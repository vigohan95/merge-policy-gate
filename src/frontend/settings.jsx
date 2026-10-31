import React, { useEffect, useState } from "react";
import ForgeReconciler, { Box, Button, CodeBlock, Heading, Inline, Lozenge, SectionMessage, Spinner, Stack, Text, Strong, useProductContext, xcss } from "@forge/react";
import { invoke } from "@forge/bridge";

const rowStyle = xcss({ paddingBlock: "space.075", borderBottomWidth: "border.width", borderBottomStyle: "solid", borderColor: "color.border" });

function slugsFrom(context) {
  const m = /bitbucket\.org\/([^/]+)\/([^/]+)\//.exec(String(context?.extension?.location || ""));
  return { workspace: m?.[1], repo: m?.[2], repoUuid: context?.extension?.repository?.uuid };
}

function PolicyTable({ policy }) {
  const rows = [
    ["§2.1 protected paths", (policy.protected_paths || []).join(", ")],
    ["§2.2 dependency files", (policy.dependency_files || []).join(", ")],
    ["§2.2 automatic bumps", (policy.dependency_bumps?.auto || []).join(", ")],
    ["§2.2 human bumps", (policy.dependency_bumps?.human || []).join(", ")],
    ["§3.4 max changed lines / files", `${policy.limits?.max_changed_lines} / ${policy.limits?.max_changed_files}`],
    ["§3.5 block drafts", String(policy.block_drafts)],
    ["§3.6 human approvals required", String(policy.human_approvals_required)],
    ["§4.1 Jira key required", String(policy.jira_required)],
  ];
  return (
    <Stack space="space.0">
      {rows.map(([k, v]) => (
        <Box key={k} xcss={rowStyle}>
          <Inline space="space.200" spread="space-between">
            <Text><Strong>{k}</Strong></Text>
            <Text>{v || "—"}</Text>
          </Inline>
        </Box>
      ))}
    </Stack>
  );
}

function App() {
  const context = useProductContext();
  const [status, setStatus] = useState(null);
  const [prs, setPrs] = useState(null);
  const [runs, setRuns] = useState({});
  const [showTemplate, setShowTemplate] = useState(false);
  const args = slugsFrom(context);

  useEffect(() => {
    if (!args.workspace && !args.repoUuid) return;
    invoke("getPolicyStatus", args).then(setStatus);
    invoke("listOpenPrs", args).then(setPrs);
  }, [args.workspace, args.repoUuid]);

  const dryRun = async (prId) => {
    setRuns((r) => ({ ...r, [prId]: { busy: true } }));
    const res = await invoke("evaluateNow", { ...args, prId });
    setRuns((r) => ({ ...r, [prId]: { busy: false, res } }));
  };

  if (!context || !status) return <Spinner size="medium" />;
  if (status.state !== "ok") return <Text>Merge Policy Gate could not read this repository: {status.state}.</Text>;

  return (
    <Stack space="space.300">
      <Stack space="space.100">
        <Heading as="h3">Policy on the default branch</Heading>
        {status.found ? (
          <SectionMessage appearance="success" title={`MERGE-POLICY.md found on ${status.branch}`}>
            <Text>Every pull request into {status.branch} is judged by this file at evaluation time. Verdicts cite policy={status.source}.</Text>
          </SectionMessage>
        ) : (
          <SectionMessage appearance="warning" title={`No MERGE-POLICY.md on ${status.branch}`}>
            <Text>The gate is running with the built-in defaults below (verdicts say policy=default). Commit the starter file to make the rules yours.</Text>
          </SectionMessage>
        )}
        <PolicyTable policy={status.policy} />
        <Inline space="space.100">
          <Button onClick={() => setShowTemplate((v) => !v)}>{showTemplate ? "Hide starter MERGE-POLICY.md" : "Show starter MERGE-POLICY.md"}</Button>
        </Inline>
        {showTemplate ? <CodeBlock language="markdown" text={status.template} /> : null}
      </Stack>

      <Stack space="space.100">
        <Heading as="h3">Dry-run on open pull requests</Heading>
        <Text>Evaluate any open pull request now with the policy above. Nothing is written to the pull request; the verdict is stored for the card and the agent.</Text>
        {!prs ? <Spinner size="small" /> : prs.length === 0 ? <Text>No open pull requests.</Text> : (
          <Stack space="space.0">
            {prs.map((pr) => {
              const run = runs[pr.id];
              const rec = run?.res?.record;
              return (
                <Box key={pr.id} xcss={rowStyle}>
                  <Stack space="space.050">
                    <Inline space="space.100" alignBlock="center" spread="space-between">
                      <Text><Strong>#{pr.id}</Strong> {pr.title} <Text>({pr.source} → {pr.destination}, {pr.author})</Text></Text>
                      <Button appearance="default" isDisabled={run?.busy} onClick={() => dryRun(pr.id)}>{run?.busy ? "Evaluating…" : "Dry-run"}</Button>
                    </Inline>
                    {rec ? (
                      <Inline space="space.100" alignBlock="center">
                        <Lozenge appearance={rec.allowed ? "success" : "removed"} isBold maxWidth={90}>{rec.allowed ? "PASS" : "HELD"}</Lozenge>
                        <Text>{rec.allowed ? `rules=[${rec.rules.join(", ")}]` : rec.reasons.join(" · ")}</Text>
                      </Inline>
                    ) : null}
                    {run?.res?.state === "error" ? <Text>Could not evaluate: {run.res.error}</Text> : null}
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        )}
      </Stack>

      <Text>Merge Policy Gate reads pull requests and repository files only; it never writes to the repository. Scopes: read:pullrequest:bitbucket, read:repository:bitbucket, storage:app.</Text>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
