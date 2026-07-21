#!/usr/bin/env bash
# Deploy supabase/functions to self-hosted Translate Supabase on the VPS.
# Live path (bind-mounted into edge-runtime as /home/deno/functions):
#   /root/supabase-translate/volumes/functions
# Note: /root is mode 700, so remote sync lands in /tmp then sudo rsyncs into place.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/supabase/functions"
REMOTE_DIR="${TRANSLATE_VPS_FUNCTIONS_DIR:-/root/supabase-translate/volumes/functions}"
HOST="${TRANSLATE_VPS_HOST:-}"
KEY="${TRANSLATE_VPS_SSH_KEY:-}"
KONG_TIMEOUT_MS="${TRANSLATE_VPS_KONG_TIMEOUT_MS:-300000}"
KONG_YML="${TRANSLATE_VPS_KONG_YML:-/root/supabase-translate/volumes/api/kong.yml}"
PATCH_PY="$ROOT/scripts/patch-kong-timeouts.py"
STAGING="/tmp/translate-functions-deploy"

if [[ ! -d "$SRC" ]]; then
  echo "Missing $SRC" >&2
  exit 1
fi

ssh_cmd=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
rsync_ssh="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
scp_cmd=(scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
if [[ -n "$KEY" ]]; then
  ssh_cmd+=(-i "$KEY")
  rsync_ssh="$rsync_ssh -i $KEY"
  scp_cmd+=(-i "$KEY")
fi

remote() {
  if [[ -z "$HOST" ]]; then
    bash -lc "$*"
  else
    "${ssh_cmd[@]}" "$HOST" "$@"
  fi
}

echo "==> Syncing edge functions -> ${HOST:+$HOST:}$REMOTE_DIR"

if [[ -z "$HOST" ]]; then
  sudo rsync -a --delete --exclude '.DS_Store' "$SRC/" "$REMOTE_DIR/"
else
  remote "rm -rf '$STAGING' && mkdir -p '$STAGING'"
  rsync -az --delete --exclude '.DS_Store' -e "$rsync_ssh" "$SRC/" "$HOST:$STAGING/"
  remote "sudo rsync -a --delete '$STAGING/' '$REMOTE_DIR/' && rm -rf '$STAGING'"
fi

echo "==> Ensuring Kong function timeouts >= ${KONG_TIMEOUT_MS}ms"
if [[ -z "$HOST" ]]; then
  sudo env TRANSLATE_VPS_KONG_TIMEOUT_MS="$KONG_TIMEOUT_MS" TRANSLATE_VPS_KONG_YML="$KONG_YML" \
    python3 "$PATCH_PY"
else
  "${scp_cmd[@]}" "$PATCH_PY" "$HOST:/tmp/patch-kong-timeouts.py"
  remote "sudo env TRANSLATE_VPS_KONG_TIMEOUT_MS=$KONG_TIMEOUT_MS TRANSLATE_VPS_KONG_YML=$KONG_YML python3 /tmp/patch-kong-timeouts.py"
fi

echo "==> Restarting edge-runtime + Kong"
remote "sudo docker restart supabasetranslate-functions-1 supabasetranslate-kong-1 >/dev/null"
remote "sleep 4; curl -fsS https://translate.lucas-dev-server.tech/functions/v1/health; echo"

echo "==> Deploy complete"
