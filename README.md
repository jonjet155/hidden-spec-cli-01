# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jonjet155/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jonjet155/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format: it applies an edit to a tree of text files,
reading the patch as a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON
text-editor calls, and writes every change or none.

Run it as `node main.ts [options] [PATCH]` (Node 22, standard library only) with the
working directory as the root of the tree. See `SPEC.md` in the kit for the full
contract: three matching tiers for drifted whitespace and indentation, wrong diff
line numbers healed by nearest occurrence, moves reported as `R old -> new`, and
`--check` / `--strict` / `--format` options.

## Files

- `main.ts`: the CLI.
- `runner.ts`: the kit's trial runner (unchanged). In a trial it reads the checks
  from the env, runs `main.ts` on each one in a fresh directory, and posts the results.
- `LICENSE`: MIT.

## Run it

```sh
node main.ts [options] [PATCH]
```

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
