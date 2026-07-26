#!/usr/bin/env bash
# Verify that the shared background-broker implementation stays in sync across
# the two repositories that embed a copy. The copies are shared at runtime via
# Symbol.for("pi-subagents.backgroundBroker"), so any drift between the two
# sources silently changes behavior depending on which package loads first.
#
# Usage:
#   scripts/check-broker-sync.sh [path-to-pi-observational-memory]
#
# The sibling checkout ../pi-observational-memory is used by default.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$HERE/src/background-broker.ts"
OM_REPO="${1:-$HERE/../pi-observational-memory}"
REMOTE="$OM_REPO/src/background-broker.ts"

if [[ ! -f "$LOCAL" ]]; then
  echo "broker-check: local copy missing: $LOCAL" >&2
  exit 1
fi
if [[ ! -f "$REMOTE" ]]; then
  echo "broker-check: pi-observational-memory checkout not found at $OM_REPO" >&2
  echo "usage: $0 [path-to-pi-observational-memory]" >&2
  exit 2
fi

if diff -q "$LOCAL" "$REMOTE" > /dev/null; then
  echo "broker-check: OK — background-broker.ts is identical in both repositories"
else
  echo "broker-check: DRIFT DETECTED between:" >&2
  echo "  $LOCAL" >&2
  echo "  $REMOTE" >&2
  echo "Resolve by copying the newer version into the other repository, then re-run." >&2
  exit 1
fi
