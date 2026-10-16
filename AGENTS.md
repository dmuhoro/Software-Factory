# AGENTS.md — how to work in Software Factory

This is the working doctrine for anyone — human or agent — changing this repository. It is
tracked so a fresh clone carries it, which is also why it exists at the root: the loop
quarantines a target's instruction files before it runs, and this repository, when it is run
against itself, is its own target.

Read these next:

- `CONTRIBUTING.md` — the contributor guide.
- `README.md` — what the product is, and how to run it.
- `doctrine/` — the machine-readable rulebook the loop obeys (`loop.json`, `agents/models.json`,
  `rules/`, `hooks/`, `manifest.json`).
- `docs/adr/` — the decisions that constrain what we may build.

## The rules that are not negotiable

- **Fail closed.** A check that cannot run refuses; it never degrades to "allowed". Defaults
  refuse. If the sandbox cannot start, the run does not proceed — see
  `src/services/sandboxPreflightService.ts`.
- **No fabricated claims.** Never state a figure, a status or a capability the repository cannot
  reproduce with a named command. Blocked work names its owner instead of a number.
- **No false confidence.** A gate, a grep or a test that can pass while the real production path
  stays unguarded is worse than none. Proof must exercise the real path, and every new test is
  shown to fail without its fix.
- **Errors publish by name.** A message is safe to a caller only if this codebase wrote it. New
  boundary codes are registered in `src/utils/apiError.ts`; anything unrecognised degrades to
  `INTERNAL_ERROR` plus an incident id. `test/l3-error-contract.test.ts` enforces the table from
  the source.
- **One writer.** The ledger takes a single writer, and the loop is the only writer of a target
  tree. Do not add a second writer, or a horizontal-scale claim.
- **No secret reaches GitHub.** Credentials are server-side only. A secret in a commit message, a
  diff, a log or a fixture is burned on push: rotate it, do not merely clean history.

## Every product update updates the README

If a change alters what the product does, what it offers, or how it is run, update `README.md` in
the **same** change. A README that describes behaviour the code no longer has is a shipped defect,
and the change is not done until the README is true again.

## Verify before you ship

Run the checks that cover what you touched:

    npm run lint          # tsc --noEmit
    npm test              # unit and source-invariant tests
    npm run verify:docs   # the documentation gates
    npm run verify        # lint, dead code (knip), test, build, and the Layer 4 harness

Wider gates: `npm run verify:full`, `verify:loop`, `verify:deploy`, `verify:evidence`,
`verify:fresh-clone`, and `verify:release`. The sandbox tests run inside `bwrap`; a host
without bubblewrap fails the preflight by design rather than running verification unsandboxed.

## Releasing

A release is described in five places that must agree — `package.json`, `package-lock.json`,
`software_factory/Cargo.toml`, `software_factory/Cargo.lock` and `CHANGELOG.md` — and is tagged.
`bash scripts/verify-release.sh` is the gate. Bump the version, add the changelog entry, commit,
tag, and push both the branch and the tag. Commits carry the `AI-Assisted:` attribution footer.
