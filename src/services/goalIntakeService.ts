/**
 * Goal intake: a one-line goal becomes a task document the loop will actually accept.
 *
 * Sprint 24. The loop consumes a strict task document; it does not consume a goal. The missing
 * step between "I want feature X" and a running loop was a human writing the document. This
 * service drafts that document with the tenant's chosen model and then holds the draft to the
 * loop's own parser before returning it: a draft the loop would refuse to parse is not a draft,
 * it is a hallucination, and it is reported as such.
 *
 * The model is never trusted to name its own provider. The Models section is dictated from the
 * caller's registered assignment and the model is told to copy it verbatim, so a draft can never
 * point the loop at a provider the tenant did not choose.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FrontierModelService } from './frontierModelService';
import { fileInventory } from './implementerService';
import { parseTaskDocument } from './taskDocumentService';
import { resolveLoopRepo } from './loopControlService';
import { workspaceRoot } from '../utils/pathGuard';

export interface GoalDraftInput {
  tenantId: string;
  repo: string;
  goal: string;
  providerId: string;
  model: string;
  maxOutputTokens?: number;
}

export interface GoalDraftResult {
  /** Path to the written draft, inside the approved workspace, ready to submit to the loop. */
  taskDocument: string;
  draft: string;
  title: string;
  milestones: Array<{ id: string; title: string }>;
  providerId: string;
  model: string;
}

function fail(code: string, detail?: string): Error {
  return new Error(detail ? `${code}:${detail}` : code);
}

export function buildGoalPrompt(repo: string, goal: string, providerId: string, model: string): { system: string; task: string } {
  const assignment = `models.implementer: ${providerId}/${model}`;
  const review = `models.reviewer: ${providerId}/${model}`;
  const system = [
    'You are the architect for an unattended software delivery loop.',
    'You turn a goal into ONE strict markdown task document that a machine parses and executes.',
    '',
    'Output ONLY the task document. No preamble, no explanation, no code fence.',
    '',
    'The document has EXACTLY this shape:',
    '# Task: <short title>',
    '',
    '## Goal',
    '<one paragraph describing the outcome that can be proven by a command>',
    '',
    '## Constraints',
    '- <a real constraint>',
    '',
    '## Models',
    assignment,
    review,
    '',
    '## Milestones',
    '### M1: <short title>',
    'type: feat',
    'verify: <a shell command that exits 0 only when this milestone is truly done>',
    '- [ ] <one behavior, provable by the verify command>',
    '',
    'Rules:',
    '- Milestone ids are M1, M2, ... and each appears exactly once.',
    '- Every milestone needs at least one "- [ ]" criterion and a "verify:" command.',
    '- "type:" is one of feat, fix, docs, refactor, test, chore.',
    `- Copy the Models section EXACTLY, character for character: "${assignment}" and "${review}".`,
    '- Add a "depends: Mx" line only when one milestone truly cannot start before another.',
    '- A verify command must be offline: no network access.',
  ].join('\n');
  const inventory = fileInventory(repo).slice(0, 200);
  const task = [
    `Goal: ${goal}`,
    '',
    `Target repository root: ${repo}`,
    'Files currently in the target repository (bounded inventory):',
    inventory.length ? inventory.join('\n') : '(empty repository)',
    '',
    'Write the task document now.',
  ].join('\n');
  return { system, task };
}

export class GoalIntakeService {
  /** Drafts a task document from a goal, then validates it with the loop's own parser. */
  public static async draft(input: GoalDraftInput): Promise<GoalDraftResult> {
    if (typeof input.goal !== 'string' || !input.goal.trim()) throw fail('LOOP_GOAL_REQUIRED');
    if (typeof input.providerId !== 'string' || !input.providerId.trim() || typeof input.model !== 'string' || !input.model.trim() || /\s/.test(input.model) || input.model.length > 128) {
      throw fail('LOOP_GOAL_MODEL_REQUIRED');
    }
    const repo = resolveLoopRepo(input.repo);

    const { system, task } = buildGoalPrompt(repo, input.goal.trim(), input.providerId, input.model);
    const response = await FrontierModelService.request(input.tenantId, {
      providerId: input.providerId,
      model: input.model,
      system,
      task,
      maxOutputTokens: input.maxOutputTokens ?? 8_000,
    });

    const raw = stripFences(response.content).trim();
    let parsed;
    try {
      parsed = parseTaskDocument(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = message.startsWith('TASK_DOCUMENT_INVALID:') ? message.slice('TASK_DOCUMENT_INVALID:'.length) : message;
      throw fail('LOOP_GOAL_DRAFT_INVALID', detail);
    }

    const dir = path.join(workspaceRoot(), '.factory-goal-drafts');
    fs.mkdirSync(dir, { recursive: true });
    const slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'task';
    const file = path.join(dir, `${slug}-${parsed.sourceHash.slice('sha256:'.length, 'sha256:'.length + 12)}.md`);
    fs.writeFileSync(file, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');

    return {
      taskDocument: file,
      draft: raw,
      title: parsed.title,
      milestones: parsed.milestones.map((milestone) => ({ id: milestone.id, title: milestone.title })),
      providerId: response.providerId,
      model: response.model,
    };
  }
}

/** Models sometimes wrap output in a fence despite instructions; unwrap exactly one layer. */
function stripFences(text: string): string {
  const match = text.match(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  return match ? match[1] : text;
}