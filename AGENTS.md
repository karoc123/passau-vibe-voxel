# AGENTS.md

## Work

- Each week should end with something newly playable.
- Refactors happen where a feature needs them, in that feature's branch. Pure cleanup (delete, merge) is always fine.
- No abstractions "for later": a new abstraction needs a real user now.
- A review ends in at most five findings, not in packages.
- A gate guards something a player would notice, or the data format.

## Docs

- Decisions in force: `docs/adr/` (decision and reason, under 40 lines, no paths or symbols). Open work: one file,
  `docs/plans/todo.md`, under 100 lines. A feature's plan is at most one page and is deleted when it lands. Questions
  to the owner: `FRAGEN.md`. How to run things: README.
- When work lands, delete its line or plan; `git log` holds the history.
- Write down only what the code, config or `--help` cannot tell: the reason, the convention, the gotcha.
- Comments give reasons. They do not describe the file, point at docs, or say where code used to be.

## Running things

- `web/tools/wt.sh` runs setup, tsc, gates and vite (`npm` is not on PATH). In an agent worktree, `tools/wt.sh setup`
  comes first. Port 5173 is the owner's dev server, 5300 the owner's game server.
- Commits stay local (the owner pushes); `.github/` is the owner's.
- Test by need: tsc and the gates guarding what you changed (`node tools/gates.mjs --list`); the full fast set once
  before handing back.
- A full data rebuild (`scripts/build_data.sh`) rewrites committed tiles: not unasked. `scripts/palette.json` is
  append-only. Open data only.
