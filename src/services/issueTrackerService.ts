/**
 * The tracker bridge: an issue on a tracker becomes the raw material for a task document.
 *
 * There are two sources and one shape. `local` reads an issue from a file inside the approved
 * workspace (offline, no network). `github` reads one issue from the GitHub REST API over the
 * guarded egress path (`egressJson`), so the same rules that govern model calls govern this one:
 * the token is a secret reference that must be allowlisted (fail closed), and it is attached only
 * to a host the guard permits. Without an allowlisted token the adapter refuses before any socket
 * is opened.
 *
 * Neither source can invent an issue. A missing file, an unparseable body, a non-2xx answer or a
 * pull-request number is a refusal, never an empty issue that a downstream architect might then
 * fill with imagined requirements.
 */
import fs from 'node:fs';
import path from 'node:path';
import { egressJson, resolveSecretRef } from '../utils/egressGuard';
import { resolveWithin } from '../utils/pathGuard';

export interface TrackerIssue {
  source: 'local' | 'github';
  id: string;
  title: string;
  body: string;
  url?: string;
  labels: string[];
}

export interface IssueFetchInput {
  /** An `IssueSourceSpec`, validated at runtime rather than trusted from the caller. */
  spec: unknown;
  timeoutMs?: number;
}

const GITHUB_API = 'https://api.github.com';

function fail(code: string, detail?: string): Error {
  return new Error(detail ? `${code}:${detail}` : code);
}

/** Loopback and `.localhost` hosts are the only ones where plain http is permitted (test stubs). */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}

interface LocalIssueFields {
  id?: string;
  title: string;
  body: string;
  url?: string;
  labels: string[];
}

/** A local issue is either a JSON object with a title, or markdown with a `# ` heading. */
export function parseLocalIssue(content: string): LocalIssueFields {
  const text = content.trim();
  if (!text) throw fail('ISSUE_LOCAL_FILE_INVALID', 'the file is empty');

  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw fail('ISSUE_LOCAL_FILE_INVALID', 'the JSON could not be parsed');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw fail('ISSUE_LOCAL_FILE_INVALID', 'the JSON is not an object');
    const record = parsed as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    if (!title) throw fail('ISSUE_LOCAL_FILE_INVALID', 'the JSON has no title');
    const labels = Array.isArray(record.labels) ? record.labels.filter((label): label is string => typeof label === 'string') : [];
    const id = typeof record.id === 'string' || typeof record.id === 'number' ? String(record.id) : undefined;
    return {
      id,
      title,
      body: typeof record.body === 'string' ? record.body : '',
      url: typeof record.url === 'string' ? record.url : undefined,
      labels,
    };
  }

  const lines = text.split('\n');
  const heading = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (heading < 0) throw fail('ISSUE_LOCAL_FILE_INVALID', 'the markdown has no "# " title heading');
  return { title: lines[heading].replace(/^#\s+/, '').trim(), body: lines.slice(heading + 1).join('\n').trim(), labels: [] };
}

export class IssueTrackerService {
  /** Reads one issue from the source the caller named, or refuses. */
  public static async fetch(input: IssueFetchInput): Promise<TrackerIssue> {
    const spec = input.spec;
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) throw fail('ISSUE_SOURCE_REQUIRED');
    const record = spec as Record<string, unknown>;
    if (record.kind === 'local') return this.readLocal(record.path);
    if (record.kind === 'github') return this.readGitHub(record, input.timeoutMs);
    if (record.kind === undefined) throw fail('ISSUE_SOURCE_REQUIRED');
    throw fail('ISSUE_SOURCE_KIND_UNKNOWN', String(record.kind));
  }

  private static readLocal(rawPath: unknown): TrackerIssue {
    if (typeof rawPath !== 'string' || !rawPath.trim()) throw fail('ISSUE_LOCAL_PATH_REQUIRED');
    const file = resolveWithin(rawPath, { code: 'ISSUE_LOCAL_PATH_OUTSIDE_WORKSPACE', mustExist: true });
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      throw fail('ISSUE_LOCAL_FILE_INVALID', 'the file could not be read');
    }
    const fields = parseLocalIssue(content);
    return { source: 'local', id: fields.id ?? path.basename(file), title: fields.title, body: fields.body, url: fields.url, labels: fields.labels };
  }

  private static async readGitHub(spec: Record<string, unknown>, timeoutMs?: number): Promise<TrackerIssue> {
    const repoRaw = typeof spec.repo === 'string' ? spec.repo.trim() : '';
    if (!repoRaw) throw fail('ISSUE_GITHUB_REPO_REQUIRED');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoRaw)) throw fail('ISSUE_GITHUB_REPO_MALFORMED');
    const number = spec.number;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) throw fail('ISSUE_GITHUB_NUMBER_REQUIRED');

    // Fail closed: no allowlisted token reference means no request is made at all.
    const token = resolveSecretRef(spec.tokenSecretRef);
    if (!token) throw fail('ISSUE_GITHUB_TOKEN_REQUIRED');

    const baseUrl = typeof spec.baseUrl === 'string' && spec.baseUrl.trim() ? spec.baseUrl.trim() : GITHUB_API;
    let hostname: string;
    try {
      hostname = new URL(baseUrl).hostname;
    } catch {
      throw fail('ISSUE_GITHUB_FETCH_FAILED', 'the base url could not be parsed');
    }
    const kind = isLoopbackHost(hostname) ? 'local' : 'remote';
    const [owner, name] = repoRaw.split('/');

    // `egressJson` re-validates the host and address at the socket boundary and is the only place
    // the token may be attached. A refused host, address or timeout stays a guard refusal.
    const { status, body } = await egressJson({
      baseUrl,
      kind,
      pathname: `/repos/${owner}/${name}/issues/${number}`,
      secret: token,
      timeoutMs,
      maxResponseBytes: 1_000_000,
    });

    if (status === 404) throw fail('ISSUE_GITHUB_NOT_FOUND');
    if (status === 401 || status === 403) throw fail('ISSUE_GITHUB_AUTH_FAILED');
    if (status < 200 || status >= 300) throw fail('ISSUE_GITHUB_FETCH_FAILED', `status ${status}`);
    if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof (body as Record<string, unknown>).title !== 'string') {
      throw fail('ISSUE_GITHUB_RESPONSE_INVALID');
    }
    const issue = body as Record<string, unknown>;
    if (issue.pull_request !== undefined) throw fail('ISSUE_GITHUB_IS_PULL_REQUEST');

    const labels = Array.isArray(issue.labels)
      ? issue.labels
          .map((label) => (typeof label === 'string' ? label : typeof label === 'object' && label !== null && typeof (label as Record<string, unknown>).name === 'string' ? String((label as Record<string, unknown>).name) : ''))
          .filter(Boolean)
      : [];
    return {
      source: 'github',
      id: typeof issue.number === 'number' ? String(issue.number) : repoRaw,
      title: (issue.title as string).trim(),
      body: typeof issue.body === 'string' ? issue.body : '',
      url: typeof issue.html_url === 'string' ? issue.html_url : undefined,
      labels,
    };
  }
}
