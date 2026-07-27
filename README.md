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
  projection. When a failover chain is configured, retries exhausted by the
  current provider advance to the next available provider/model and queue a
  follow-up turn. Unknown or structural provider errors never fail over: they
  discard the projection and force one canonical fail-open request before
  projection may resume. The classification decision is recorded in telemetry.
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
- `/vctx:failback` — switch back to the model active before failover

`/vctx:status` reports the current request estimate separately from the last
projected request, so an old `raw → sent` result is not mistaken for the current
context size.

## Provider failover

Failover is enabled by default but does nothing until a provider chain is
configured. Chain keys are source provider names; targets are ordered
`provider/modelId` strings:

```json
{
  "virtual-context": {
    "failover": {
      "enabled": true,
      "chains": {
        "kimi-coding": ["ark/glm-5.2"]
      },
      "maxFailoversPerSession": 6
    }
  }
}
```

Only transient failures after provider retries are exhausted activate a chain.
Structural or unknown request errors never switch providers. If the active model
is already a target in a chain, the next transient failure advances to the next
entry; reaching the tail records `failover_exhausted` and leaves recovery to the
user. Missing models and targets without an API key are skipped. The per-session
cap prevents repeated follow-ups or provider ping-pong after the configured
number of successful switches.

A successful switch keeps the current VCTX projection and queues the literal
`continue` as a follow-up turn, so threshold resolution and projection continue
normally for the target model. `/vctx:failback` returns to the original model.

In the currently supported Pi API, `pi.setModel()` also persists the selected
model as the default. On session shutdown this extension attempts to restore the
original model only if the active model is still the target selected by
failover; a user's later manual model selection is never overwritten. Shutdown
restore is bounded and best-effort, and `/vctx:failback` is the manual recovery
path. If restore fails, the fallback model may remain the default for a later
session and telemetry records `failback_failed`. The same applies when Pi exits
non-gracefully (crash or kill) between failover and shutdown, because no
`session_shutdown` handler runs in that case.

Failover never triggers on user aborts (`stopReason: "aborted"`): cancelling a
response keeps the projection but never switches the model or queues a
follow-up.

Implementation note: the installed extension API exposes model switching and
follow-up delivery on `ExtensionAPI`, so the extension uses `pi.setModel()` and
`pi.sendUserMessage("continue", { "deliverAs": "followUp" })`. It does not use
the older `ctx.sendUserMessage` / `streamingBehavior` spelling.

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
    "failover": {
      "enabled": true,
      "chains": {
        "kimi-coding": ["ark/glm-5.2"]
      },
      "maxFailoversPerSession": 6
    },
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
