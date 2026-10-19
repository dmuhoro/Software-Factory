# ADR-020: Backup/restore drill runs in CI

## Status

Accepted.

## Context

`scripts/backup-restore-drill.ts` corrupts the ledger, triggers
`DurableStore` recovery, and measures RPO/RTO — but it only ran when an operator
manually invoked it. A recovery drill that never runs is not a drill; it is an
unverified assumption that backups work.

## Decision

The backup/restore drill is added to the CI `verify.yml` TypeScript job as a
credential-free step. It runs against a fresh checkout, corrupts the ledger in a
temp data directory, triggers store recovery, and asserts:

- `restoredFromBackup == true`
- `recordsLost == false`
- `status == PASS`

Because it is destructive to in-memory state only (temp data dir), it is safe to
run in CI against a fresh clone. A non-zero exit fails the build.

## Consequences

- Positive: RPO/RTO is measured on every change; a broken backup chain fails the
  build before it reaches production.
- Negative: the drill adds runtime to CI; it is not run against production data.
- Recovery: the drill's own backup/restore cycle proves the `.bak` and
  `.archive-*` rotation mechanism works.

## Related

- `scripts/backup-restore-drill.ts` — the drill
- `docs/BACKUP_RESTORE.md` — operator recovery runbook
- `src/services/durableStore.ts` — single-writer ledger with backup rotation
- Sprint 34, WP-7 (P1 Supply chain)
