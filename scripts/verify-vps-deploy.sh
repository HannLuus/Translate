#!/usr/bin/env bash
# Smoke-check production Translate API after a VPS deploy.
set -euo pipefail

BASE="${TRANSLATE_API_BASE:-https://translate.lucas-dev-server.tech/functions/v1}"
HOST="${TRANSLATE_VPS_HOST:-}"
KEY="${TRANSLATE_VPS_SSH_KEY:-}"
REMOTE_DIR="${TRANSLATE_VPS_FUNCTIONS_DIR:-/root/supabase-translate/volumes/functions}"

ssh_cmd=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
if [[ -n "$KEY" ]]; then
  ssh_cmd+=(-i "$KEY")
fi

echo "==> Health: $BASE/health"
curl -fsS "$BASE/health"
echo

if [[ -n "$HOST" ]]; then
  echo "==> Remote workerTimeoutMs / Gemini defaults"
  "${ssh_cmd[@]}" "$HOST" "sudo grep -n workerTimeoutMs '$REMOTE_DIR/main/index.ts' | head -3; sudo grep -nE 'VERTEX_MODEL|GEMINI_DEV_MODEL' '$REMOTE_DIR/_shared/gemini.ts' | head -10"
else
  echo "==> Local workerTimeoutMs / Gemini defaults"
  sudo grep -n workerTimeoutMs "$REMOTE_DIR/main/index.ts" | head -3
  sudo grep -nE 'VERTEX_MODEL|GEMINI_DEV_MODEL' "$REMOTE_DIR/_shared/gemini.ts" | head -10
fi

echo "==> Verify OK"
