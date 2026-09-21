import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface DurableState {
  version: 2;
  telemetry: Record<string, Record<string, unknown>>;
  transformations: Record<string, Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  factoryJobs: Record<string, Record<string, unknown>>;
  repositoryContexts: Record<string, Record<string, unknown>>;
  qualitySnapshots: Record<string, Record<string, unknown>>;
  approvals: Record<string, Record<string, unknown>>;
}

const defaultState = (): DurableState => ({
  version: 2,
  telemetry: {},
  transformations: {},
  audits: [],
  factoryJobs: {},
  repositoryContexts: {},
  qualitySnapshots: {},
  approvals: {},
});

export class DurableStore {
  private static state: DurableState | undefined;
  private static dataFile(): string {
    return path.resolve(process.env.FACTORY_DATA_DIR || '.data', 'software-factory.json');
  }

  private static ensureLoaded(): DurableState {
    if (this.state) return this.state;
    const file = this.dataFile();
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DurableState>;
      this.state = { ...defaultState(), ...loaded, version: 2, repositoryContexts: loaded.repositoryContexts ?? {}, qualitySnapshots: loaded.qualitySnapshots ?? {}, approvals: loaded.approvals ?? {} };
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') throw error;
      this.state = defaultState();
      this.persist();
    }
    return this.state;
  }

  private static persist(): void {
    const file = this.dataFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state ?? defaultState(), null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  public static resetForTests(): void {
    this.state = undefined;
  }

  public static id(prefix: string, entropy: string): string {
    return `${prefix}_${crypto.createHash('sha256').update(`${entropy}:${Date.now()}:${process.pid}`).digest('hex').slice(0, 20)}`;
  }

  public static upsert(collection: 'telemetry' | 'transformations' | 'factoryJobs' | 'repositoryContexts' | 'qualitySnapshots' | 'approvals', id: string, value: Record<string, unknown>): void {
    const state = this.ensureLoaded();
    state[collection][id] = value;
    this.persist();
  }

  public static get(collection: 'telemetry' | 'transformations' | 'factoryJobs' | 'repositoryContexts' | 'qualitySnapshots' | 'approvals', id: string): Record<string, unknown> | undefined {
    return this.ensureLoaded()[collection][id];
  }

  public static list(collection: 'telemetry' | 'transformations' | 'factoryJobs' | 'repositoryContexts' | 'qualitySnapshots' | 'approvals'): Record<string, unknown>[] {
    return Object.values(this.ensureLoaded()[collection]);
  }

  public static appendAudit(value: Record<string, unknown>): void {
    const state = this.ensureLoaded();
    state.audits.push(value);
    this.persist();
  }

  public static audits(tenantId?: string): Record<string, unknown>[] {
    const logs = this.ensureLoaded().audits;
    return tenantId ? logs.filter((log) => log.tenantId === tenantId) : [...logs];
  }
}
