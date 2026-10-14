/**
 * The tracker bridge entry point: an issue from a tracker becomes a validated task document.
 *
 * The bridge is deliberately thin. `IssueTrackerService` reads the issue from whichever source the
 * caller named (a local file, or the GitHub API guarded by the egress rules); this service turns it
 * into a spec draft through the exact same model contract and parser as goal intake
 * (`draftTaskDocument`), so a draft an issue produces is no more and no less trusted than a draft a
 * goal produces. An issue that cannot be read never reaches the model at all.
 */
import { IssueTrackerService } from './issueTrackerService';
import type { TrackerIssue } from './issueTrackerService';
import { draftTaskDocument, taskDocumentSystem, resolveLearning } from './goalIntakeService';
import type { GoalDraftResult } from './goalIntakeService';
import { fileInventory } from './implementerService';
import { resolveLoopRepo } from './loopControlService';
import { injectLearningDigest, type LearningDigest } from './learningDigestService';

export interface IssueIntakeInput {
  tenantId: string;
  repo: string;
  source: unknown;
  providerId: string;
  model: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface IssueIntakeResult extends GoalDraftResult {
  issue: { source: string; id: string; title: string; url?: string; labels: string[] };
}

function fail(code: string, detail?: string): Error {
  return new Error(detail ? `${code}:${detail}` : code);
}

/** The prompt is the same architect contract as a goal, with the issue as the request. */
export function buildIssuePrompt(repo: string, issue: TrackerIssue, providerId: string, model: string, learning: { digest?: LearningDigest; enabled: boolean } = { enabled: false }): { system: string; task: string } {
  const inventory = fileInventory(repo).slice(0, 200);
  const task = [
    `Issue source: ${issue.source}`,
    issue.url ? `Issue URL: ${issue.url}` : '',
    `Issue: #${issue.id}`,
    `Title: ${issue.title}`,
    issue.labels.length ? `Labels: ${issue.labels.join(', ')}` : '',
    '',
    'Body:',
    issue.body || '(the issue has no body; derive criteria from the title only, and add nothing the title does not imply)',
    '',
    `Target repository root: ${repo}`,
    'Files currently in the target repository (bounded inventory):',
    inventory.length ? inventory.join('\n') : '(empty repository)',
    '',
    'Write the task document now.',
  ].filter(Boolean).join('\n');
  return { system: taskDocumentSystem(providerId, model), task: injectLearningDigest(task, learning.digest, learning.enabled) };
}

export class IssueIntakeService {
  /** Fetches the named issue, drafts a task document from it, and validates it with the parser. */
  public static async draft(input: IssueIntakeInput): Promise<IssueIntakeResult> {
    if (typeof input.providerId !== 'string' || !input.providerId.trim() || typeof input.model !== 'string' || !input.model.trim() || /\s/.test(input.model) || input.model.length > 128) {
      throw fail('LOOP_ISSUE_MODEL_REQUIRED');
    }
    const repo = resolveLoopRepo(input.repo);
    const issue = await IssueTrackerService.fetch({ spec: input.source, timeoutMs: input.timeoutMs });

    const { system, task } = buildIssuePrompt(repo, issue, input.providerId, input.model, resolveLearning(input.tenantId));
    const draft = await draftTaskDocument({
      tenantId: input.tenantId,
      system,
      task,
      providerId: input.providerId,
      model: input.model,
      maxOutputTokens: input.maxOutputTokens,
      invalidCode: 'LOOP_ISSUE_DRAFT_INVALID',
    });
    return {
      ...draft,
      issue: { source: issue.source, id: issue.id, title: issue.title, url: issue.url, labels: issue.labels },
    };
  }
}