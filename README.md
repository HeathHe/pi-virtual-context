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
- Transient provider failures (including overload/rate-limit/429/5xx,
  network/timeout/context-length errors) and aborted requests retain the active
  projection for Pi's retry. Unknown or structural provider errors discard the
  projection and force one canonical fail-open request before projection may
  resume. The classification decision is recorded in telemetry.
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

## Threshold resolution and overrides

`thresholdsMode: "static"` uses the four configured token thresholds directly.
`thresholdsMode: "ratio"` uses the larger of each static threshold and its
context-window ratio. A matching `thresholdOverrides` entry takes precedence
and `/vctx:status` reports its source as `override`.

Each override must select at least one non-empty `provider` or `model` and must
provide the complete `targetTokens < prepareTokens < swapTokens < emergencyTokens`
group as positive integers. A provider-and-model selector is more specific than
a single-field selector; the first match at the same specificity wins.

```json
{
  "virtual-context": {
    "thresholdOverrides": [
      {
        "provider": "provider-name",
        "prepareTokens": 70000,
        "swapTokens": 85000,
        "targetTokens": 55000,
        "emergencyTokens": 105000
      },
      {
        "provider": "provider-name",
        "model": "model-id",
        "prepareTokens": 60000,
        "swapTokens": 75000,
        "targetTokens": 45000,
        "emergencyTokens": 90000
      }
    ]
  }
}
```

Global and project settings are shallow-merged. Therefore a project-level
`thresholdOverrides` array replaces the complete global array; entries are not
merged individually. Omitting `thresholdOverrides` preserves the existing
static/ratio behavior unchanged.

## Recommended settings

```json
{
  "virtual-context": {
    "mode": "shadow",
    "thresholdsMode": "static",
    "thresholdOverrides": [],
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
