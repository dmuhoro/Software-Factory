/**
 * Writer-lock probe: a second live process attempting to write the same ledger.
 *
 * Run with a `FACTORY_DATA_DIR` that another process already holds. A correct ledger refuses
 * this process rather than letting two writers interleave records, so the expected result is a
 * non-zero exit whose stderr names `LEDGER_ANOTHER_WRITER_ACTIVE`. A zero exit means the writer
 * lock is not actually cross-process, which is the defect the lock exists to prevent.
 *
 * Kept as a standalone script so a test can exercise the boundary between two real processes,
 * not a simulated one.
 */
import { DurableStore } from '../src/services/durableStore';

try {
  DurableStore.upsert('qualitySnapshots', `probe-${process.pid}`, { id: `probe-${process.pid}`, tenantId: 'probe' });
  process.stdout.write('WRITE_OK\n');
  process.exit(0);
} catch (error) {
  process.stderr.write(`REFUSED:${(error as Error).message}\n`);
  process.exit(1);
}