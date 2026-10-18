#!/usr/bin/env tsx
/**
 * `npm run backup:restore-drill`
 *
 * Software Factory recovery drill (Layer 3 Durability).
 *
 * Measures RPO and RTO by:
 *  1. Recording the ledger record count (baseline)
 *  2. Writing a known probe record
 *  3. Backing up the ledger file
 *  4. Corrupting the ledger (simulating disk failure)
 *  5. Restarting the store (triggering recovery)
 *  6. Measuring recovery time (RTO) and records lost (RPO)
 *
 * The store's recovery path (DurableStore.ensureLoaded) quarantines the corrupt
 * document and restores from the last known-good backup. This drill proves that
 * path works and measures how long it takes and how much data is lost.
 *
 * Exit 0: recovery succeeded, RPO/RTO measured.
 * Exit 1: recovery failed — the drill itself is the failure signal.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { DurableStore } from '../src/services/durableStore';

interface DrillResult {
  baselineRecords: number;
  backupPath: string;
  corruptPath: string | undefined;
  recoveryTimeMs: number;
  restoredFromBackup: boolean;
  recordsLost: boolean;
  recoveredRecords: number;
  rpoSeconds: number;
  rtoSeconds: number;
  status: 'PASS' | 'FAIL';
}

async function main(): Promise<void> {
  const start = Date.now();

  // Ensure the store is loaded from the current data dir.
  DurableStore.resetForTests();
  const dataFile = DurableStore.dataFile();
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });

  // 1. Baseline: record the current record count.
  const statsBefore = DurableStore.stats();
  const baselineRecords = Object.values(statsBefore.collections).reduce((a, b) => a + b, 0);

  // 2. Write a known probe record so we can detect data loss.
  const probeId = DurableStore.deterministicId('drill-probe', String(process.pid), String(Date.now()));
  DurableStore.upsert('qualitySnapshots', probeId, {
    id: probeId,
    tenantId: '__drill__',
    productName: 'backup-restore-drill probe',
    score: 42,
    baselineScore: 0,
    improvementPercent: 0,
    dimensions: { verification: 0, security: 0, evidence: 0, operability: 0, productDiscipline: 0 },
    evidenceKinds: [],
    recordedAt: new Date().toISOString(),
  });

  // 3. Back up the ledger.
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-drill-backup-'));
  const backupPath = path.join(backupDir, 'software-factory.json');
  fs.copyFileSync(dataFile, backupPath);

  // 4. Corrupt the ledger (simulate disk failure).
  fs.writeFileSync(dataFile, '{ corrupt json that is not valid ', 'utf8');

  // 5. Restart the store (triggers recovery).
  DurableStore.resetForTests();
  const recoveryStart = Date.now();
  const statsAfter = DurableStore.stats();
  const recoveryTimeMs = Date.now() - recoveryStart;

  const recoveredRecords = Object.values(statsAfter.collections).reduce((a, b) => a + b, 0);
  const recovery = DurableStore.lastRecovery();
  const restoredFromBackup = recovery?.restoredFromBackup ?? false;
  const recordsLost = recovery?.recordsLost ?? true;

  // 6. Measure RPO and RTO.
  const rtoSeconds = recoveryTimeMs / 1000;
  // RPO: how much data was lost. If the probe record is gone, RPO > 0.
  const probeStillExists = DurableStore.exists('qualitySnapshots', probeId);
  const rpoSeconds = probeStillExists ? 0 : rtoSeconds; // if probe lost, RPO equals the recovery window

  const result: DrillResult = {
    baselineRecords,
    backupPath,
    corruptPath: dataFile,
    recoveryTimeMs,
    restoredFromBackup,
    recordsLost,
    recoveredRecords,
    rpoSeconds,
    rtoSeconds,
    status: restoredFromBackup && !recordsLost ? 'PASS' : 'FAIL',
  };

  console.log('═══ Backup/Restore Drill Results ═══');
  console.log(`  Baseline records: ${baselineRecords}`);
  console.log(`  Recovered records: ${recoveredRecords}`);
  console.log(`  Restored from backup: ${restoredFromBackup}`);
  console.log(`  Records lost: ${recordsLost}`);
  console.log(`  Probe record survives: ${probeStillExists}`);
  console.log(`  Recovery time (RTO): ${rtoSeconds.toFixed(3)}s`);
  console.log(`  Data loss window (RPO): ${rpoSeconds.toFixed(3)}s`);
  console.log(`  Status: ${result.status}`);
  console.log('═════════════════════════════════════');

  // Cleanup: restore the good backup so the next run starts clean.
  try {
    DurableStore.resetForTests();
    fs.copyFileSync(backupPath, dataFile);
    DurableStore.resetForTests();
  } catch { /* best effort */ }

  process.exit(result.status === 'PASS' ? 0 : 1);
}

main().catch((error) => {
  console.error(`DRILL FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
