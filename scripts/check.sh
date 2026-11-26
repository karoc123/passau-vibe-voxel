#!/usr/bin/env bash
# The pipeline's quick gates, run from anywhere; the web's are web/tools/gates.mjs.
#   palette     scripts/palette_check.py: the palette registry is append-only against HEAD
#   overrides   scripts/overrides.py check: every per-object override valid (needs data/raw/osm.json; stale ones are
#               printed, not failed)
#   interiors   scripts/interiors.py --test: the synthetic checks of carving rooms
#   lanes       scripts/traffic.py --lane-check: the lane spacing the same in traffic.py and web/src/sim/road-net.ts
# --fixture adds scripts/check.py verify: the hard checks on the fixture map's build (builds its workspace
# data/check/<fixture>/base first where code or inputs changed: ~5 min from nothing, seconds when it is up to date).
# usage: scripts/check.sh [--fixture]; a PASS / FAIL table with times, exit code 1 if a gate fails
set -u
cd "$(dirname "$0")/.."

fixture=0
for a in "$@"; do
  case "$a" in
    --fixture) fixture=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

names=() results=() times=()
gate() {
  local name=$1; shift
  local t0=$SECONDS out rc
  echo "== $name: $*"
  out=$("$@" 2>&1); rc=$?
  printf '%s\n' "$out" | tail -n 20
  names+=("$name") times+=("$((SECONDS - t0))")
  if [ $rc -eq 0 ]; then results+=(PASS); else results+=("FAIL (exit $rc)"); fi
}

gate palette uv run python scripts/palette_check.py
gate overrides uv run python scripts/overrides.py check
gate interiors uv run python scripts/interiors.py --test
gate lanes uv run python scripts/traffic.py --lane-check
if [ $fixture -eq 1 ]; then
  gate fixture-verify uv run python scripts/check.py verify
fi

fail=0
printf '\n%-15s %-14s %s\n' gate result time
for i in "${!names[@]}"; do
  printf '%-15s %-14s %s s\n' "${names[$i]}" "${results[$i]}" "${times[$i]}"
  [ "${results[$i]}" = PASS ] || fail=1
done
[ $fail -eq 0 ] && echo "PASS" || echo "FAIL"
exit $fail
