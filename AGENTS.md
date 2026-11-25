# AGENTS.md

## Docs

- Keep docs lean and live: decisions in force (`docs/adr/`), open work (`docs/plans/`), how to run things (README).
- When work lands, delete its plan, section or table row; `git log` holds the history. A fact still worth knowing
  goes in one sentence into the doc that stays.
- Write down only what the code, config or `--help` cannot tell: the reason, the convention, the gotcha. Name code by
  path and symbol, not line number.

## Running things

- `web/tools/wt.sh` runs setup, tsc, gates and vite (`npm` is not on PATH). In an agent worktree, `tools/wt.sh setup`
  comes first.
- Test by need: tsc and the gates guarding what you changed (`node tools/gates.mjs --list`); the full fast set once
  before handing back.
