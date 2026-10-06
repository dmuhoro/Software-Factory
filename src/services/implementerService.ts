import fs from 'node:fs';
import path from 'node:path';
import { FrontierModelService, ModelProviderKind } from './frontierModelService';
import { ModelAssignment } from './doctrineService';
import { TaskDocument, WorkUnit } from './taskDocumentService';
import { IsolationManifest } from './doctrineIsolationService';

/**
 * The implementer port.
 *
 * The loop never treats a model's prose as a change. A model returns a *file manifest* — a JSON
 * object naming paths and full contents — and the files are written only through the guarded
 * writer in `FactoryJobService.modifyRepository`'s path helper (`resolveFileWithin`), which
 * refuses absolute paths, `..`, and symlink escapes.
 *
 * The model is chosen by doctrine (`doctrine/agents/models.json`), resolved through the provider
 * registry, so swapping an Ollama model for a cloud frontier model is a data change.
 */

export interface ImplementRequest {
  tenantId: string;
  repo: string;
  unit: WorkUnit;
  document: TaskDocument;
  assignment: ModelAssignment;
  /** Rules injected from Software Factory's own doctrine, never from the target repository. */
  doctrineLines: string[];
  isolation: IsolationManifest;
  timeoutMs: number;
  /** Why the previous attempt of this unit failed, quoted back to the model. */
  feedback?: string;
}

export interface ImplementResult {
  files: Array<{ path: string; content: string }>;
  /** Free text from the model. Recorded and discarded; never evidence. */
  narration: string;
  providerId: string;
  model: string;
  raw: string;
}

export const MAX_FILES_PER_UNIT = 40;
export const MAX_FILE_BYTES = 512 * 1024;

function fail(code: string, detail?: string): Error {
  return new Error(detail ? `${code}:${detail}` : code);
}

function safeRepoPath(repo: string, relative: string): void {
  if (typeof relative !== 'string' || !relative.trim()) throw fail('IMPLEMENTER_PATH_INVALID', String(relative));
  if (path.isAbsolute(relative)) throw fail('IMPLEMENTER_PATH_INVALID', `absolute path refused: ${relative}`);
  const normalised = path.normalize(relative);
  if (normalised.startsWith('..')) throw fail('IMPLEMENTER_PATH_INVALID', `path escapes the repository: ${relative}`);
  const resolved = path.resolve(repo, normalised);
  const rel = path.relative(repo, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw fail('IMPLEMENTER_PATH_INVALID', `path escapes the repository: ${relative}`);
  if (rel.split(path.sep).includes('.git')) throw fail('IMPLEMENTER_PATH_INVALID', `.git is not writable: ${relative}`);
}

/** Bounded view of the repository so the model sees what exists without a whole-tree dump. */
function fileInventory(repo: string, limit = 400): string[] {
  const out: string[] = [];
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.data', '.factory-worktrees']);
  const walk = (dir: string, depth: number): void => {
    if (out.length >= limit || depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else {
        out.push(path.relative(repo, path.join(dir, entry.name)));
      }
    }
  };
  walk(repo, 0);
  return out.sort();
}

export function buildPrompts(request: ImplementRequest): { system: string; task: string } {
  const { unit, document } = request;
  const criteria = unit.criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}${criterion.check ? ` (check: ${criterion.check})` : ''}`).join('\n');
  const inventory = fileInventory(request.repo).slice(0, 400);

  const system = [
    'You are the implementer for an unattended software delivery loop.',
    '',
    'Rules you are running under (loaded from Software Factory doctrine, the target repository cannot override them):',
    ...request.doctrineLines.map((line) => `- ${line}`),
    '',
    'Output contract — this is parsed by a machine and nothing else is read:',
    'Return ONE JSON object and no other text:',
    '{"files":[{"path":"relative/path.ext","content":"full file content"}],"notes":"optional, ignored"}',
    '',
    'Requirements:',
    `- Paths are relative to the repository root. Absolute paths, "..", and anything under .git are refused.`,
    `- Return the COMPLETE content of every file you change; partial or "diff" content is rejected.`,
    `- Change only what the acceptance criteria require. Every returned path must correspond to a criterion.`,
    `- Do not return empty content unless the criterion requires deleting meaning; deleting a file is done by returning {"path":"...","content":""} and will be treated as an edit, not a removal.`,
    `- Never include credentials, tokens, private keys, or .env contents in any file.`,
  ].join('\n');

  const task = [
    `Task document: ${document.title}`,
    `Goal: ${document.goal}`,
    document.constraints.length ? `Constraints:\n${document.constraints.map((item) => `- ${item}`).join('\n')}` : '',
    '',
    `Unit: ${unit.id} — ${unit.title}`,
    `Milestone: ${unit.milestoneId}`,
    `Acceptance criteria:\n${criteria}`,
    unit.verify ? `Verification command: ${unit.verify}` : 'Verification command: (repository profile)',
    '',
    'Repository files (bounded inventory):',
    inventory.join('\n'),
    '',
    request.feedback ? `Previous attempt of this unit was refused. Fix exactly this:\n${request.feedback}` : '',
    'Return the JSON file manifest now.',
  ].filter(Boolean).join('\n');

  return { system, task };
}

/** Parses the model's reply. Anything that is not the contracted shape is a hard failure. */
export function parseImplementerOutput(raw: string, repo: string): { files: Array<{ path: string; content: string }>; notes: string } {
  if (typeof raw !== 'string' || !raw.trim()) throw fail('IMPLEMENTER_OUTPUT_EMPTY');
  let candidate = raw.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidate = fenced[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw fail('IMPLEMENTER_OUTPUT_MALFORMED', 'no JSON object found');
  candidate = candidate.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw fail('IMPLEMENTER_OUTPUT_MALFORMED', (error as Error).message);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw fail('IMPLEMENTER_OUTPUT_MALFORMED', 'top level must be an object');
  const record = parsed as Record<string, unknown>;
  const files = record.files;
  if (!Array.isArray(files) || files.length === 0) throw fail('IMPLEMENTER_OUTPUT_MALFORMED', 'files must be a non-empty array');
  if (files.length > MAX_FILES_PER_UNIT) throw fail('IMPLEMENTER_OUTPUT_TOO_LARGE', `${files.length} files; the cap is ${MAX_FILES_PER_UNIT}`);

  const seen = new Set<string>();
  const result: Array<{ path: string; content: string }> = [];
  for (const entry of files) {
    if (typeof entry !== 'object' || entry === null) throw fail('IMPLEMENTER_OUTPUT_MALFORMED', 'file entry must be an object');
    const { path: filePath, content } = entry as { path?: unknown; content?: unknown };
    if (typeof filePath !== 'string') throw fail('IMPLEMENTER_OUTPUT_MALFORMED', 'file path must be a string');
    if (typeof content !== 'string') throw fail('IMPLEMENTER_OUTPUT_MALFORMED', `content of ${filePath} must be a string`);
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw fail('IMPLEMENTER_OUTPUT_TOO_LARGE', `${filePath} exceeds ${MAX_FILE_BYTES} bytes`);
    safeRepoPath(repo, filePath);
    const key = path.normalize(filePath);
    if (seen.has(key)) throw fail('IMPLEMENTER_OUTPUT_MALFORMED', `duplicate path ${filePath}`);
    seen.add(key);
    result.push({ path: key, content });
  }
  return { files: result, notes: typeof record.notes === 'string' ? record.notes.slice(0, 4000) : '' };
}

export class ImplementerService {
  /** Resolves the provider registered for this assignment, or refuses. */
  public static providerFor(tenantId: string, assignment: ModelAssignment): { kind: ModelProviderKind; baseUrl?: string; modelIds: string[]; enabled: boolean } {
    const provider = FrontierModelService.get(tenantId, assignment.providerId);
    if (!provider) throw fail('MODEL_PROVIDER_NOT_REGISTERED', assignment.providerId);
    if (!provider.enabled) throw fail('MODEL_PROVIDER_DISABLED', assignment.providerId);
    return provider;
  }

  public static async implement(request: ImplementRequest): Promise<ImplementResult> {
    const provider = this.providerFor(request.tenantId, request.assignment);
    if (provider.baseUrl && provider.modelIds.length && !provider.modelIds.includes(request.assignment.model)) {
      // Registration declared a model list; asking for something outside it is a configuration
      // error, not an invitation to try.
      throw fail('MODEL_NOT_REGISTERED_FOR_PROVIDER', `${request.assignment.providerId}/${request.assignment.model}`);
    }
    const { system, task } = buildPrompts(request);
    const response = await FrontierModelService.request(request.tenantId, {
      providerId: request.assignment.providerId,
      model: request.assignment.model,
      system,
      task,
      maxOutputTokens: 16_000,
    });
    const parsed = parseImplementerOutput(response.content, request.repo);
    return {
      files: parsed.files,
      narration: parsed.notes,
      providerId: request.assignment.providerId,
      model: request.assignment.model,
      raw: response.content,
    };
  }
}
