/**
 * Durable Ledger Store.
 *
 * Persistence port for the founder runtime. The current adapter writes a single
 * JSON document atomically to local disk; ADR-001 reserves the Appwrite adapter as
 * the multi-tenant replacement. This adapter is therefore explicitly SINGLE-WRITER.
 *
 * Durability contract:
 *  - A write is atomic (temp file + fsync + rename + directory fsync).
 *  - A previous good document is retained and used for recovery.
 *  - A CORRUPT document can never prevent the process from starting. It is
 *    quarantined, an attempt is made to restore the retained copy, and the
 *    degradation is recorded so the health endpoint can report it truthfully.
 *  - An unknown future schema version is refused rather than silently coerced.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LEDGER_VERSION = 5 as const;

/**
 * Oldest document this build can still read and migrate forward.
 *
 * Version 4 lacked the `tenants` collection. Bumping the version while refusing anything
 * older would have routed every existing deployment through the corrupt-document recovery
 * path, which quarantines the live ledger and resets it -- the schema change would have
 * destroyed the data it was meant to preserve. A missing collection is coerced to empty by
 * `hydrate`, so the migration is additive and needs no record rewrite.
 */
export const MIN_LEDGER_VERSION = 4 as const;

export const LEDGER_COLLECTIONS = [
  'telemetry', 'transformations', 'factoryJobs', 'repositoryContexts', 'qualitySnapshots',
  'approvals', 'projects', 'backups', 'releases', 'failures', 'outcomes', 'autonomySessions',
  'clientWorkspaces', 'handovers', 'clientAcceptances', 'hostedDeployments', 'modelProviders',
  'agentRuns', 'worktrees', 'proofRecords', 'queueJobs', 'executionRuns',
  'deploymentObservations', 'mergeRecords', 'securityScans', 'projectAdapters',
  'tenants', 'factoryLoopRuns',
] as const;

export type LedgerCollection = (typeof LEDGER_COLLECTIONS)[number];

export interface LedgerRecovery {
  occurredAt: string;
  reason: string;
  quarantinedPath: string;
  restoredFromBackup: boolean;
  recordsLost: boolean;
}

export interface DurableState {
  version: typeof LEDGER_VERSION;
  telemetry: Record<string, Record<string, unknown>>;
  transformations: Record<string, Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  factoryJobs: Record<string, Record<string, unknown>>;
  repositoryContexts: Record<string, Record<string, unknown>>;
  qualitySnapshots: Record<string, Record<string, unknown>>;
  approvals: Record<string, Record<string, unknown>>;
  projects: Record<string, Record<string, unknown>>;
  backups: Record<string, Record<string, unknown>>;
  releases: Record<string, Record<string, unknown>>;
  failures: Record<string, Record<string, unknown>>;
  outcomes: Record<string, Record<string, unknown>>;
  autonomySessions: Record<string, Record<string, unknown>>;
  clientWorkspaces: Record<string, Record<string, unknown>>;
  handovers: Record<string, Record<string, unknown>>;
  clientAcceptances: Record<string, Record<string, unknown>>;
  hostedDeployments: Record<string, Record<string, unknown>>;
  modelProviders: Record<string, Record<string, unknown>>;
  agentRuns: Record<string, Record<string, unknown>>;
  worktrees: Record<string, Record<string, unknown>>;
  proofRecords: Record<string, Record<string, unknown>>;
  queueJobs: Record<string, Record<string, unknown>>;
  executionRuns: Record<string, Record<string, unknown>>;
  deploymentObservations: Record<string, Record<string, unknown>>;
  mergeRecords: Record<string, Record<string, unknown>>;
  securityScans: Record<string, Record<string, unknown>>;
  projectAdapters: Record<string, Record<string, unknown>>;
  tenants: Record<string, Record<string, unknown>>;
  factoryLoopRuns: Record<string, Record<string, unknown>>;
}

/** Audit log is append-only but bounded; an unbounded array is a disk-exhaustion risk. */
const MAX_AUDIT_ENTRIES = Math.min(Math.max(Number(process.env.FACTORY_MAX_AUDIT_ENTRIES) || 10_000, 100), 1_000_000);
/** Number of retained previous-good documents. */
const MAX_BACKUP_ROTATIONS = 3;
/** A stale writer lock older than this is considered abandoned and may be broken. */
const LOCK_STALE_MS = Math.min(Math.max(Number(process.env.FACTORY_STORE_LOCK_TTL_MS) || 30_000, 5_000), 600_000);

type Collections = Record<LedgerCollection, Record<string, Record<string, unknown>>>;

function emptyCollections(): Collections {
  return Object.fromEntries(LEDGER_COLLECTIONS.map((name) => [name, {}])) as unknown as Collections;
}

function defaultState(): DurableState {
  return { version: LEDGER_VERSION, audits: [], ...emptyCollections() } as DurableState;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a parsed document and coerces missing collections to empty.
 *
 * Version handling refuses in both directions. A document from a NEWER build is refused
 * because this code cannot know what it would be dropping; a document from an UNSUPPORTED
 * older build is refused because silently coercing it would invent a shape. A document
 * between the two is migrated forward, which here means the new collection starts empty.
 */
function hydrate(loaded: unknown): DurableState {
  if (!isPlainObject(loaded)) throw new Error('LEDGER_ROOT_NOT_AN_OBJECT');
  const version = loaded.version;
  if (version !== undefined) {
    if (typeof version !== 'number' || !Number.isInteger(version)) throw new Error('LEDGER_VERSION_INVALID');
    if (version > LEDGER_VERSION) throw new Error(`LEDGER_VERSION_FUTURE:${version}`);
    if (version < MIN_LEDGER_VERSION) throw new Error(`LEDGER_VERSION_UNSUPPORTED:${version}`);
  }
  const collections = emptyCollections();
  for (const name of LEDGER_COLLECTIONS) {
    const value = (loaded as Record<string, unknown>)[name];
    if (value === undefined) continue;
    if (!isPlainObject(value)) throw new Error(`LEDGER_COLLECTION_INVALID:${name}`);
    for (const [id, record] of Object.entries(value)) {
      if (isPlainObject(record)) collections[name][id] = record;
    }
  }
  const audits = Array.isArray(loaded.audits) ? loaded.audits.filter(isPlainObject) : [];
  return { version: LEDGER_VERSION, audits: audits.slice(-MAX_AUDIT_ENTRIES), ...collections } as DurableState;
}

export class DurableStore {
  private static state: DurableState | undefined;
  private static recovery: LedgerRecovery | undefined;
  private static lockHeld = false;

  public static dataFile(): string {
    return path.resolve(process.env.FACTORY_DATA_DIR || '.data', 'software-factory.json');
  }

  private static backupFile(): string { return `${this.dataFile()}.bak`; }
  private static lockFile(): string { return `${this.dataFile()}.lock`; }

  /**
   * Reports the most recent recovery event, or undefined when the ledger has
   * loaded cleanly since process start. Surfaced by the health endpoint so an
   * operator is never told the store is healthy while it silently lost records.
   */
  public static lastRecovery(): LedgerRecovery | undefined { this.ensureLoaded(); return this.recovery; }

  public static isDegraded(): boolean { return this.recovery !== undefined; }

  /** True when another live process holds the writer lock. */
  public static hasContendedWriter(): boolean {
    const lock = this.lockFile();
    try {
      const stat = fs.statSync(lock);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) return false;
      const holder = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid?: number };
      if (holder.pid === process.pid) return false;
      try { process.kill(holder.pid ?? 0, 0); return true; } catch { return false; }
    } catch {
      return false;
    }
  }

  private static acquireLock(): void {
    if (this.lockHeld) return;
    // The lock lives beside the ledger, so the directory has to exist before the lock can
    // be created. On a first run the data directory is absent, and opening the lock with
    // 'wx' would fail ENOENT -- which surfaced as "ledger unusable" and refused startup.
    fs.mkdirSync(path.dirname(this.dataFile()), { recursive: true });
    const lock = this.lockFile();
    const payload = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = fs.openSync(lock, 'wx', 0o600);
        fs.writeFileSync(handle, payload);
        fs.closeSync(handle);
        this.lockHeld = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (attempt === 0 && this.hasContendedWriter()) {
          throw new Error('LEDGER_ANOTHER_WRITER_ACTIVE');
        }
        // Stale or self-owned lock: break it and retry once.
        try { fs.unlinkSync(lock); } catch { /* another process won the race */ }
      }
    }
  }

  private static releaseLock(): void {
    if (!this.lockHeld) return;
    try { fs.unlinkSync(this.lockFile()); } catch { /* best effort */ }
    this.lockHeld = false;
  }

  private static quarantine(reason: string): string {
    const file = this.dataFile();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${file}.corrupt-${stamp}`;
    try {
      fs.copyFileSync(file, target);
      fs.unlinkSync(file);
    } catch {
      return '';
    }
    // A quarantine copy that cannot be written must not block startup.
    return target;
  }

  private static readDocument(file: string): unknown {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  private static ensureLoaded(): DurableState {
    // The lock is taken on EVERY access, not just the first load. A writer lock that is
    // released after each write protects nothing: the window between two writes is exactly
    // when a second process would acquire it and start interleaving records.
    this.acquireLock();
    if (this.state) return this.state;
    const file = this.dataFile();
    let parsed: unknown;
    let failure = '';
    try {
      parsed = this.readDocument(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.state = defaultState();
        this.persist();
        return this.state;
      }
      failure = `read failed (${code ?? (error as Error).name})`;
    }
    if (!failure) {
      try {
        this.state = hydrate(parsed);
        // A migrated document is rewritten so the file and the process agree on the version.
        // Leaving it at the old version means every restart re-runs the migration, and an
        // operator reading the file sees a version the running build no longer claims. It
        // also means a later build that drops support for the old version breaks every
        // ledger that was never actually migrated.
        const onDisk = (parsed as Record<string, unknown>).version;
        if (onDisk !== LEDGER_VERSION) this.persist();
        return this.state;
      } catch (error) {
        failure = (error as Error).message;
      }
    }
    // Recovery path: a corrupt or unreadable document MUST NOT prevent startup.
    const quarantinedPath = this.quarantine(failure);
    let restored = false;
    let restoredState: DurableState | undefined;
    try {
      restoredState = hydrate(this.readDocument(this.backupFile()));
      restored = true;
    } catch {
      restoredState = undefined;
    }
    this.state = restoredState ?? defaultState();
    this.recovery = {
      occurredAt: new Date().toISOString(),
      reason: failure,
      quarantinedPath,
      restoredFromBackup: restored,
      recordsLost: !restored,
    };
    // eslint-disable-next-line no-console -- startup must be audible; a silent reset is the failure mode this replaces
    console.error(JSON.stringify({ level: 'ERROR', service: 'software-factory-ledger', message: 'Durable ledger was unreadable and has been recovered', metadata: this.recovery }));
    this.persist();
    return this.state;
  }

  private static persist(): void {
    const file = this.dataFile();
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.acquireLock();
    try {
      const state = this.state ?? defaultState();
      // Retain the last known-good document before replacing it.
      if (fs.existsSync(file)) {
        try { fs.copyFileSync(file, this.backupFile()); } catch { /* a missing backup must not block the write */ }
      }
      const temp = `${file}.${process.pid}.tmp`;
      const handle = fs.openSync(temp, 'w', 0o600);
      try {
        fs.writeFileSync(handle, JSON.stringify(state, null, 2));
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.renameSync(temp, file);
      // fsync the directory so the rename itself is durable.
      try {
        const dir = fs.openSync(directory, 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      } catch { /* not permitted on every platform; the file fsync already ran */ }
      this.rotateBackups(file);
    } finally {
      // The lock is deliberately NOT released here. See ensureLoaded(): a per-write
      // release leaves the ledger unprotected between writes.
    }
  }

  /**
   * Releases the writer lock. Called on graceful shutdown and by tests, never by a write.
   */
  public static releaseWriterLock(): void {
    this.releaseLock();
  }

  /** Keeps a small ring of previous-good documents for operator forensics. */
  private static rotateBackups(file: string): void {
    try {
      const archives = fs.readdirSync(path.dirname(file))
        .filter((name) => name.startsWith(`${path.basename(file)}.archive-`))
        .sort();
      while (archives.length >= MAX_BACKUP_ROTATIONS) {
        const oldest = archives.shift();
        if (oldest) fs.unlinkSync(path.join(path.dirname(file), oldest));
      }
      fs.copyFileSync(file, path.join(path.dirname(file), `${path.basename(file)}.archive-${Date.now()}`));
    } catch { /* archival is best effort */ }
  }

  /** Drops the in-memory copy. Test-only; production code must not call this. */
  public static resetForTests(): void {
    this.state = undefined;
    this.recovery = undefined;
    this.releaseLock();
  }

  /**
   * Atomically replaces the entire document from a serialized payload.
   * Used by backup restore. The payload is validated before it is accepted, so a
   * damaged backup is rejected rather than becoming the new source of truth, and
   * the in-memory copy is swapped under the writer lock so no in-flight write can
   * clobber the restored state.
   */
  public static replaceDocument(serialized: string): void {
    const next = hydrate(JSON.parse(serialized));
    this.acquireLock();
    try {
      const file = this.dataFile();
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (fs.existsSync(file)) {
        try { fs.copyFileSync(file, this.backupFile()); } catch { /* a missing backup must not block the write */ }
      }
      const temp = `${file}.${process.pid}.restore`;
      const handle = fs.openSync(temp, 'w', 0o600);
      try {
        fs.writeFileSync(handle, JSON.stringify(next, null, 2));
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.renameSync(temp, file);
      this.state = next;
    } finally {
      this.releaseLock();
    }
  }

  public static id(prefix: string, entropy: string): string {
    return `${prefix}_${crypto.createHash('sha256').update(`${entropy}:${Date.now()}:${process.pid}`).digest('hex').slice(0, 20)}`;
  }

  /**
   * A record identifier derived purely from its content, with no time or process
   * component. Two callers that supply the same partition key receive the same id,
   * so a subsequent upsert overwrites rather than duplicates. This is how the
   * ADR-001 composite unique index on `[tenant_id, idempotency_key]` is enforced:
   * replay protection is structural, not a lookup that can be raced or skipped.
   *
   * DO NOT change the separator in the line below, and do not "tidy" it into a visible
   * character. It is a NUL byte on purpose: joining with '' would make ['ab','c'] and
   * ['a','bc'] hash identically, so two different idempotency keys could collapse onto
   * one document. The byte is also load-bearing across upgrades -- telemetry document ids
   * are produced here, so altering the digest input would make every already-recorded
   * idempotency key unreachable after a deploy and silently re-admit the replays it was
   * written to reject. The NUL is why this file reads as binary to a naive `grep`; that
   * is the cheaper problem.
   */
  public static deterministicId(prefix: string, ...parts: string[]): string {
    return `${prefix}_${crypto.createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 32)}`;
  }

  /**
   * True when a record with this identifier already exists. Lets a caller report
   * "this was a replay" without a full collection scan.
   */
  public static exists(collection: LedgerCollection, id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.ensureLoaded()[collection], id);
  }

  public static upsert(collection: LedgerCollection, id: string, value: Record<string, unknown>): void {
    if (!LEDGER_COLLECTIONS.includes(collection)) throw new Error(`LEDGER_COLLECTION_UNKNOWN:${collection}`);
    if (typeof id !== 'string' || id === '') throw new Error('LEDGER_RECORD_ID_REQUIRED');
    const state = this.ensureLoaded();
    state[collection][id] = value;
    this.persist();
  }

  public static get(collection: LedgerCollection, id: string): Record<string, unknown> | undefined {
    if (!LEDGER_COLLECTIONS.includes(collection)) throw new Error(`LEDGER_COLLECTION_UNKNOWN:${collection}`);
    return this.ensureLoaded()[collection][id];
  }

  public static list(collection: LedgerCollection): Record<string, unknown>[] {
    if (!LEDGER_COLLECTIONS.includes(collection)) throw new Error(`LEDGER_COLLECTION_UNKNOWN:${collection}`);
    return Object.values(this.ensureLoaded()[collection]);
  }

  /**
   * Like `list`, but with the record's actual storage key.
   *
   * A record that stores its own identity inside the value can disagree with the key it is
   * filed under, and only this view exposes both. A caller that validates identity MUST use
   * this rather than `list`, or the check compares the id to itself and can never fail.
   */
  public static entries(collection: LedgerCollection): Array<[string, Record<string, unknown>]> {
    if (!LEDGER_COLLECTIONS.includes(collection)) throw new Error(`LEDGER_COLLECTION_UNKNOWN:${collection}`);
    return Object.entries(this.ensureLoaded()[collection]);
  }

  public static has(collection: LedgerCollection, predicate: (record: Record<string, unknown>) => boolean): boolean {
    return this.list(collection).some(predicate);
  }

  public static appendAudit(value: Record<string, unknown>): void {
    const state = this.ensureLoaded();
    state.audits.push(value);
    if (state.audits.length > MAX_AUDIT_ENTRIES) state.audits = state.audits.slice(-MAX_AUDIT_ENTRIES);
    this.persist();
  }

  public static audits(tenantId?: string): Record<string, unknown>[] {
    const logs = this.ensureLoaded().audits;
    return tenantId ? logs.filter((log) => log.tenantId === tenantId) : [...logs];
  }

  /** Number of persisted records, for the health endpoint. */
  public static stats(): { collections: Record<string, number>; audits: number; version: number; degraded: boolean } {
    const state = this.ensureLoaded();
    const collections: Record<string, number> = {};
    for (const name of LEDGER_COLLECTIONS) collections[name] = Object.keys(state[name]).length;
    return { collections, audits: state.audits.length, version: LEDGER_VERSION, degraded: this.isDegraded() };
  }
}
