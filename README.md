# pi-virtual-context

A local, non-invasive Pi extension that projects a smaller provider context while
leaving Pi's append-only session history untouched.

## What it does

1. Measures every logical model request in the public `context` hook.
2. Starts a smart checkpoint with the configured summary model after `prepareTokens`.
3. Replaces the provider view after `swapTokens` with one checkpoint plus a
   complete recent suffix.
4. Archives large text-only tool results privately and substitutes file-backed
   previews only in the provider projection. The canonical Pi session keeps the
   original tool result.
5. Archives oversized text-only user inputs without changing the canonical input;
   only the provider-bound context receives the file-backed preview.
6. Invalidates derived checkpoints on native compaction, tree navigation, model
   changes, forks, switches, and shutdown.
7. Keeps an activated projection sticky across consecutive provider requests;
   projected usage is never reused as the size of the canonical full history.
8. Treats `targetTokens` as a real per-request soft ceiling. It first preserves
   the configured recent suffix, then shortens the checkpoint only when the
   measured projection is over target, and moves the safe cut only as a final
   fallback. If fixed overhead makes the target impossible, telemetry records
   the over-target result instead of dropping structurally required messages.

It does not modify Pi core, global `node_modules`, or the session JSONL format.

## Safety model

- Default mode is `shadow`: telemetry only; provider messages are unchanged.
- `enabled` mode may send the prefix selected for checkpointing to the configured
  summary provider (`ark/glm-5.2` by default).
- Smart checkpoints are accepted only when their exact canonical prefix hash is
  still valid and the cut boundary remains structurally safe.
- If the smart checkpoint is not ready at the swap line, a bounded deterministic
  checkpoint is used.
- The reduction threshold is an activation gate only. After the first valid
  projection, matching checkpoints remain active until an explicit invalidation
  or checkpoint refresh, preventing projected/full-history oscillation.
- Tool-call/result pairing is preserved by cutting only at user-like or assistant
  boundaries, never at a standalone `toolResult`. This also covers a single long
  user turn containing many model/tool cycles.
- Artifact directories use mode `0700`; files use mode `0600`.
- Provider failures and aborted requests discard committed projections and force
  one canonical fail-open request before projection may resume.
- Smart checkpoints share a process-level provider queue with observational-memory.
  Foreground agent work preempts the background lease; VCTX resumes only after
  `agent_end`, so summary generation cannot compete with the main response.

This extension materially reduces repeated old-prefix reads. It is not a core
provider-admission gate, so it cannot claim a mathematical, all-code-path
"never overflow" guarantee.

## Commands

- `/vctx:status`
- `/vctx:mode off|shadow|enabled` — runtime only
- `/vctx:reset`

`/vctx:status` reports the current request estimate separately from the last
projected request, so an old `raw → sent` result is not mistaken for the current
context size.

## Recommended settings

```json
{
  "virtual-context": {
    "mode": "shadow",
    "prepareTokens": 80000,
    "swapTokens": 95000,
    "targetTokens": 65000,
    "emergencyTokens": 120000,
    "keepRecentTokens": 12000,
    "fallbackOverheadTokens": 50000,
    "minReductionTokens": 30000,
    "minReductionRatio": 0.3,
    "maxWaitMs": 3000,
    "summaryTimeoutMs": 60000,
    "summaryReserveTokens": 10000,
    "minCallsBetweenRefresh": 10,
    "artifactThresholdTokens": 2000,
    "artifactPreviewChars": 4000,
    "artifactToolNames": ["read", "grep", "find", "ls", "bash"],
    "virtualizeLargeInputs": true,
    "maxSingleInputTokens": 60000,
		"debugLog": false,
		"allowCrossProvider": false,
    "summaryModel": {
      "provider": "ark",
      "id": "glm-5.2",
      "thinking": "off"
    }
  }
}
```

Telemetry is opt-in (`debugLog: false` by default) and contains counts, hashed
session keys, and redacted diagnostics, not prompts, tool-result content, or raw
local paths. It is written with private permissions under
`~/.pi/agent/virtual-context/telemetry/`. Full archived results are stored under
`~/.pi/agent/virtual-context/artifacts/`. Provider-facing references use `~/...`
under the home directory and an absolute readable path for explicitly configured
agent directories outside home. Set `allowCrossProvider: true` explicitly
when the summary model intentionally uses a different provider from the main model.
