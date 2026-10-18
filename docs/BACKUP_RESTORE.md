# Backup & Restore — Recovery Runbook (P1 Durability)

This document is the operator-facing recovery procedure for the Software Factory durable
ledger. It is written against the code, not the ambition: every step names the file,
script, or command that performs it.

## What the ledger is

The durable ledger is a single-writer JSON document at `FACTORY_DATA_DIR/software-factory.json`
(default `.data/software-factory.json`). It is rewritten atomically (temp file + fsync +
rename + directory fsync) on every change, and the previous good document is retained as
`.data/software-factory.json.bak` before each replacement. A rolling ring of up to 3
archive copies (`.data/software-factory.json.archive-<timestamp>`) is also kept.

## Recovery objectives (measured, not asserted)

The backup/restore drill (`scripts/backup-restore-drill.ts`) measures:

| Objective | What it means | How it is measured |
|-----------|---------------|--------------------|
| **RPO** (Recovery Point Objective) | How much data may be lost | The drill corrupts the ledger, restores from backup, and reports `recordsLost`. A `true` means records were lost since the last backup. |
| **RTO** (Recovery Time Objective) | How long recovery takes | The drill measures the time from corruption to a restored, writable store. |

Run the drill to measure your actual RPO/RTO:

```bash
npm run backup:restore-drill
```

Expected output on a healthy system:

```
Restored from backup: true
Records lost: false
Recovery time (RTO): 0.003s
Data loss window (RPO): 0.003s
Status: PASS
```

If `Records lost: true`, the last backup predates some accepted writes — those writes are
gone and must be re-ingested from their source.

## The recovery procedure

When the ledger is corrupt or unreadable:

### 1. Confirm the failure

The health endpoint reports the store state:

```bash
curl -s http://localhost:3000/factory/health | jq '.checks.durableStore'
```

A `fail` state with `ledger unusable` or `write probe did not persist` means the ledger
cannot be read. The process starts anyway (fail-safe: a corrupt ledger must not prevent
startup), but writes go to a fresh empty store until recovery runs.

### 2. Run the drill (validates recovery before you trust it)

```bash
npm run backup:restore-drill
```

This corrupts a copy of the ledger, triggers `DurableStore.ensureLoaded()` recovery, and
reports whether the store restored from the last known-good backup and whether records
were lost. If the drill fails, do not proceed to production traffic — the backup chain
is broken.

### 3. Restore from the last known-good backup

The store keeps the previous good document at:

```
.data/software-factory.json.bak
```

And up to 3 archives:

```
.data/software-factory.json.archive-<timestamp>
```

To restore manually, stop the process, then replace the corrupt ledger with the backup:

```bash
# Stop the factory process first
cp .data/software-factory.json.bak .data/software-factory.json
# Then restart — DurableStore.ensureLoaded() validates the restored document on boot
```

If the `.bak` is also corrupt, use the most recent `.archive-*` file:

```bash
ls -t .data/software-factory.json.archive-* | head -1
cp <that-file> .data/software-factory.json
```

### 4. Verify the restore

Start the process and check the health endpoint:

```bash
curl -s http://localhost:3000/factory/health | jq '.checks.durableStore, .recovery'
```

`durableStore` should be `healthy` and `recovery` should be `null` (no recovery in
progress). The record count should match what was in the backup.

## Scheduling the drill

The drill is destructive to the in-memory store (it corrupts then restores), so it must
NOT run against a production process handling live traffic. Run it:

- On a staging / replica instance on a schedule (for example weekly via cron), or
- On a production replica that is taken out of rotation during the drill.

Example cron entry (weekly, against a staging instance):

```cron
0 2 * * 0 cd /opt/software-factory && npm run backup:restore-drill >> /var/log/factory/drill.log 2>&1
```

Alert on non-zero exit: a failed drill means the backup chain cannot be trusted.

## What is NOT covered by this runbook

- **Multi-replica writes (NC-2)** remain open: the local ledger is single-writer. A
  second concurrent writer is detected and refused (`hasContendedWriter`). Horizontal
  scale requires a shared store (Appwrite adapter) — see ADR-015.
- **Appwrite persistence**: if `STORAGE_BACKEND=appwrite`, the ledger lives in Appwrite
  and its backups are managed by Appwrite's scheduled backups, not this file-based drill.
  Verify which backend is active before relying on this runbook (`GET /factory/health`
  reports the storage backend).

## Related

- `scripts/backup-restore-drill.ts` — the drill implementation
- `npm run backup:restore-drill` — run the drill
- `scripts/verify-slo.ts` — SLO verification including durable-store-not-degraded
- ADR-009 — one storage backend selected explicitly
- ADR-015 — horizontal scale requires a shared store (NC-2)
