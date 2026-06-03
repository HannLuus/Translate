#!/usr/bin/env bash
# Add x-recent-context to Kong CORS on the self-hosted Supabase VPS.
#
# OPTIONS preflight is answered by Kong (not edge functions), so updating
# supabase/functions/_shared/cors.ts alone does not fix browser CORS.
#
# Run ON THE VPS (or via ssh user@translate.lucas-dev-server.tech 'bash -s' < this file):
#
#   grep -n 'x-meeting-context' /path/to/supabase/docker/volumes/api/kong.yml
#   # In the functions-v1 (edge-runtime) service cors plugin config.headers list, add:
#   #   - x-recent-context
#   docker compose restart kong   # or your stack's kong container name
#
# Verify from your laptop:
#   curl -sI -X OPTIONS "https://translate.lucas-dev-server.tech/functions/v1/interpret" \
#     -H "Origin: https://translate-murex-three.vercel.app" \
#     -H "Access-Control-Request-Method: POST" \
#     -H "Access-Control-Request-Headers: x-recent-context" \
#     | grep -i access-control-allow-headers
#
# Expected: line includes x-recent-context

set -euo pipefail

KONG_YML="${KONG_YML:-}"

if [[ -z "$KONG_YML" ]]; then
  for candidate in \
    /root/supabase/docker/volumes/api/kong.yml \
    /home/*/supabase/docker/volumes/api/kong.yml \
    ./docker/volumes/api/kong.yml; do
    if [[ -f "$candidate" ]]; then
      KONG_YML="$candidate"
      break
    fi
  done
fi

if [[ -z "$KONG_YML" || ! -f "$KONG_YML" ]]; then
  echo "Set KONG_YML to your Supabase kong.yml path (edge-runtime / functions-v1 cors headers)." >&2
  exit 1
fi

if grep -q 'x-recent-context' "$KONG_YML"; then
  echo "Already present in $KONG_YML"
  exit 0
fi

echo "Edit $KONG_YML manually:"
echo "  In the edge functions route cors plugin, add x-recent-context next to x-meeting-context."
echo "Then restart Kong, e.g.: docker restart supabase-kong"
