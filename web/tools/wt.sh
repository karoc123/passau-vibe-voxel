#!/usr/bin/env bash
# Dev commands in this checkout or an agent worktree (.claude/worktrees/*). In a worktree they use the main
# checkout's node_modules and data (web/public), and vite its own dep cache.
#   tools/wt.sh setup            link node_modules from the main checkout (a worktree's first step)
#   tools/wt.sh tsc              type check
#   tools/wt.sh gates [args]     tools/gates.mjs
#   tools/wt.sh vite [port]      dev server on 127.0.0.1 (default: the first free port from 5230)
#   tools/wt.sh <script> [args]  node <script>, e.g. tools/judder.mjs 5230 --what car
set -euo pipefail
web="$(cd "$(dirname "$0")/.." && pwd)"
main="$(git -C "$web" worktree list --porcelain | sed -n '1s/^worktree //p')"
cd "$web"
if [ "$web" != "$main/web" ]; then
  export VOXEL_DATA="${VOXEL_DATA:-$main/web/public/data}"
  export VOXEL_PUBLIC="$main/web/public"
  export VOXEL_VITE_CACHE="$main/web/node_modules/.vite-$(basename "$(dirname "$web")")"
fi
cmd="${1:-}"; shift || true
case "$cmd" in
  setup)
    [ "$web" = "$main/web" ] && { echo "main checkout: nothing to link"; exit 0; }
    ln -sfn "$main/web/node_modules" node_modules
    echo "linked node_modules; data: $VOXEL_PUBLIC" ;;
  tsc) exec node node_modules/typescript/bin/tsc --noEmit -p . ;;
  gates) exec node tools/gates.mjs "$@" ;;
  vite)
    port="${1:-}"
    if [ -z "$port" ]; then
      port=5230
      while (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; do port=$((port + 1)); done
    fi
    echo "vite on http://127.0.0.1:$port/"
    exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$port" --strictPort ;;
  '') sed -n '2,8p' "$0" | sed 's/^# //'; exit 1 ;;
  *) exec node "$cmd" "$@" ;;
esac
