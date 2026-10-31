import React, { useEffect, useState } from "react";
import ForgeReconciler, { Box, Button, Heading, Inline, Lozenge, Spinner, Stack, Text, Strong, useProductContext, xcss } from "@forge/react";
import { invoke } from "@forge/bridge";

const rowStyle = xcss({ paddingBlock: "space.050", borderBottomWidth: "border.width", borderBottomStyle: "solid", borderColor: "color.border" });
// Keeps the status lozenge from being squeezed to "H.." by the flex row.
const badgeStyle = xcss({ minWidth: "4rem" });

function RuleRow({ row }) {
  const appearance = row.status === "held" ? "removed" : row.status === "ok" ? "success" : "default";
  const label = row.status === "held" ? "HELD" : row.status === "ok" ? "OK" : "SEEN";
  return (
    <Box xcss={rowStyle}>
      <Inline space="space.100" alignBlock="start">
        <Box xcss={badgeStyle}><Lozenge appearance={appearance} isBold maxWidth={90}>{label}</Lozenge></Box>
        <Stack space="space.0">
          <Text><Strong>{row.rule}</Strong> {row.text}</Text>
          {row.reason ? <Text>{row.reason}</Text> : null}
          {row.unblock ? <Text>→ {row.unblock}</Text> : null}
        </Stack>
      </Inline>
    </Box>
  );
}

function App() {
  const context = useProductContext();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const repoUuid = context?.extension?.repository?.uuid;
  const prId = context?.extension?.pullRequest?.id;
  // The host page URL carries the slugs (bitbucket.org/<workspace>/<repo>/pull-requests/<id>); the UUID alone
  // cannot be turned into slugs without an extra scope, so we pass both.
  const m = /bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/.exec(String(context?.extension?.location || ""));
  const args = { repoUuid, prId: prId || (m ? Number(m[3]) : undefined), workspace: m?.[1], repo: m?.[2] };

  useEffect(() => {
    if (!args.prId || (!repoUuid && !args.workspace)) return;
    invoke("getVerdict", args).then(setData);
  }, [repoUuid, prId, args.workspace]);

  const reevaluate = async () => {
    setBusy(true);
    try { setData(await invoke("evaluateNow", args)); } finally { setBusy(false); }
  };

  if (!context || !data) return <Spinner size="medium" />;

  if (data.state === "unknown-repo") {
    return <Text>Merge Policy Gate has not seen this repository yet. Enable the check under Repository settings → Custom merge checks and push once.</Text>;
  }
  const rec = data.record;
  return (
    <Stack space="space.150">
      {rec ? (
        <>
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance={rec.allowed ? "success" : "removed"} isBold>{rec.allowed ? "PASS" : "HELD"}</Lozenge>
            <Text>{rec.allowed ? "The policy holds; this pull request may merge." : `${rec.violated.length} rule${rec.violated.length === 1 ? "" : "s"} not satisfied.`}</Text>
          </Inline>
          <Stack space="space.0">{rec.rows.map((row) => <RuleRow key={row.rule} row={row} />)}</Stack>
          <Text>
            {rec.facts?.changedFiles} files · {rec.facts?.changedLines} lines · {rec.facts?.approvalsByOthers} approval{rec.facts?.approvalsByOthers === 1 ? "" : "s"} by others
            {rec.facts?.draft ? " · draft" : ""}{rec.facts?.jira?.key ? ` · ${rec.facts.jira.key}` : ""}
          </Text>
          <Text>policy={rec.policySource} · evaluated {new Date(rec.evaluatedAt).toLocaleString()}{data.state === "fresh" ? " (just now)" : ""}</Text>
        </>
      ) : (
        <Text>No verdict stored yet for this pull request. Push a commit, or evaluate it now.</Text>
      )}
      {data.state === "error" ? <Text>Could not evaluate: {data.error}</Text> : null}
      <Inline>
        <Button appearance="primary" isDisabled={busy} onClick={reevaluate}>{busy ? "Evaluating…" : "Re-evaluate now"}</Button>
      </Inline>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
