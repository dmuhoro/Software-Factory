/**
 * The interactive intake ("grill session") — Sprint 33, WP-2.
 *
 * The goal and issue bridges draft a task document from a one-shot prompt. A grill session is the
 * human-in-the-loop alternative: the factory asks the operator one clarifying question at a time,
 * the operator answers, and only then is a task document drafted — through the SAME parse-or-refuse
 * path the other bridges use (`draftTaskDocument` → `parseTaskDocument`), so a grilled document is
 * no more trusted than a goal-drafted one.
 *
 * The whole session is durable (ADR-001/ADR-013): every turn is written to the ledger as it happens,
 * so a restart mid-session resumes where it stopped, and the service reads its own state back from
 * disk rather than from memory. Sessions are tenant-scoped: a foreign session id is a miss, never a
 * forbidden resource, and never a leak.
 *
 * The question source is a seam (`GrillAsker`). Production asks the tenant's own model; tests inject
 * a scripted asker, exactly as `WebhookService.setTransportForTests` injects a transport. The hard
 * cap is enforced here, not by the model: a session can never ask more than `cap` questions, however
 * eager the model is.
 */
import { DurableStore } from './durableStore';
import { FrontierModelService } from './frontierModelService';
import { buildGoalPrompt, draftTaskDocument, resolveLearning, type GoalDraftResult } from './goalIntakeService';
import { resolveLoopRepo } from './loopControlService';
import { SkillInjectionService } from './skillInjectionService';

interface GrillTurn {
  question: string;
  answer?: string;
}

type GrillStatus = 'asking' | 'ready' | 'drafted';

export interface GrillSession {
  sessionId: string;
  tenantId: string;
  repo: string;
  goal: string;
  providerId: string;
  model: string;
  status: GrillStatus;
  cap: number;
  turns: GrillTurn[];
  createdAt: string;
  updatedAt: string;
  taskDocument?: string;
}

interface GrillQuestion {
  question: string;
  done: boolean;
}

interface GrillAskerInput {
  tenantId: string;
  providerId: string;
  model: string;
  goal: string;
  transcript: GrillTurn[];
  cap: number;
}

export type GrillAsker = (input: GrillAskerInput) => Promise<GrillQuestion>;

export interface StartInput {
  tenantId: string;
  repo: unknown;
  goal: unknown;
  providerId: unknown;
  model: unknown;
}
export interface AnswerInput {
  tenantId: string;
  sessionId: string;
  answer: unknown;
}
export interface FinishInput {
  tenantId: string;
  sessionId: string;
}

export interface StartResult {
  sessionId: string;
  status: GrillStatus;
  cap: number;
  questionNumber: number;
  question?: string;
  done: boolean;
}
export interface AnswerResult {
  sessionId: string;
  status: GrillStatus;
  answered: number;
  questionNumber: number;
  question?: string;
  done: boolean;
}

function fail(code: string, detail?: string): Error {
  return new Error(detail ? `${code}:${detail}` : code);
}

const MIN_CAP = 1;
const MAX_CAP = 32;
const DEFAULT_CAP = 8;

/** The hard cap. The model cannot raise it; the operator can lower it. Bounded so a grill is finite. */
function resolveGrillCap(): number {
  const configured = Number(process.env.FACTORY_GRILL_MAX_QUESTIONS);
  const value = Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : DEFAULT_CAP;
  return Math.min(Math.max(value, MIN_CAP), MAX_CAP);
}

function requireModel(providerId: unknown, model: unknown): { providerId: string; model: string } {
  if (typeof providerId !== 'string' || !providerId.trim() || typeof model !== 'string' || !model.trim() || /\s/.test(model) || model.length > 128) {
    throw fail('LOOP_GRILL_MODEL_REQUIRED');
  }
  return { providerId: providerId.trim(), model: model.trim() };
}

const QUESTION_SYSTEM = [
  'You are conducting a short, focused intake interview to sharpen a software task the factory will build unattended.',
  'Ask exactly ONE question per turn — the single most valuable thing still unknown — then stop.',
  'Do not answer your own question. Do not ask compound questions. Do not repeat a question that has been answered.',
  'When you have enough to write a precise task document, stop asking.',
  '',
  'Reply with JSON only, one of:',
  '  {"question": "<one question>"}',
  '  {"done": true}',
].join('\n');

function transcriptText(goal: string, transcript: GrillTurn[]): string {
  const lines = [`Goal: ${goal}`, '', 'Clarifications so far:'];
  if (!transcript.length) lines.push('(none yet)');
  transcript.forEach((turn, index) => {
    lines.push(`${index + 1}. Q: ${turn.question}`);
    if (turn.answer !== undefined) lines.push(`   A: ${turn.answer}`);
  });
  lines.push('', 'Ask your next question, or reply {"done": true} if you have enough.');
  return lines.join('\n');
}

/** Strips one layer of a ```json fence the model may add despite instructions. */
function stripFence(text: string): string {
  const match = text.match(/^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return match ? match[1] : text;
}

function parseQuestion(content: string): GrillQuestion {
  let doc: unknown;
  try {
    doc = JSON.parse(stripFence(content.trim()));
  } catch {
    throw fail('MODEL_PROVIDER_INVALID_RESPONSE', 'the grill question was not JSON');
  }
  if (typeof doc !== 'object' || doc === null) throw fail('MODEL_PROVIDER_INVALID_RESPONSE', 'the grill question was not an object');
  const question = (doc as { question?: unknown }).question;
  const done = (doc as { done?: unknown }).done;
  if (done === true) return { question: '', done: true };
  if (typeof question !== 'string' || !question.trim()) throw fail('MODEL_PROVIDER_INVALID_RESPONSE', 'the grill question was empty');
  return { question: question.trim(), done: false };
}

const defaultAsker: GrillAsker = async (input) => {
  const response = await FrontierModelService.request(input.tenantId, {
    providerId: input.providerId,
    model: input.model,
    system: QUESTION_SYSTEM,
    task: transcriptText(input.goal, input.transcript),
    maxOutputTokens: 1_000,
  });
  return parseQuestion(response.content);
};

let asker: GrillAsker | null = null;

function currentAsker(): GrillAsker {
  return asker ?? defaultAsker;
}

export class GrillSessionService {
  /** Test seam: replace the question source, mirroring `WebhookService.setTransportForTests`. */
  public static setAskerForTests(replacement: GrillAsker | null): void {
    asker = replacement;
  }

  private static read(tenantId: string, sessionId: string): GrillSession {
    const record = DurableStore.get('grillSessions', String(sessionId)) as unknown as GrillSession | undefined;
    // Tenant scoping: a session belonging to another tenant is a miss, not a forbidden resource.
    if (!record || record.tenantId !== tenantId) throw fail('LOOP_GRILL_NOT_FOUND');
    return record;
  }

  private static write(session: GrillSession): void {
    session.updatedAt = new Date().toISOString();
    DurableStore.upsert('grillSessions', session.sessionId, session as unknown as Record<string, unknown>);
  }

  public static get(tenantId: string, sessionId: string): GrillSession | undefined {
    const record = DurableStore.get('grillSessions', String(sessionId)) as unknown as GrillSession | undefined;
    return record && record.tenantId === tenantId ? record : undefined;
  }

  /** Starts a session and asks the first question (or none, if the model is already satisfied). */
  public static async start(input: StartInput): Promise<StartResult> {
    const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
    if (!goal) throw fail('LOOP_GRILL_GOAL_REQUIRED');
    const { providerId, model } = requireModel(input.providerId, input.model);
    const repo = resolveLoopRepo(input.repo);
    const cap = resolveGrillCap();

    const session: GrillSession = {
      sessionId: DurableStore.id('grill', `${input.tenantId}:${repo}:${goal}`),
      tenantId: input.tenantId,
      repo,
      goal,
      providerId,
      model,
      status: 'asking',
      cap,
      turns: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const next = await currentAsker()({ tenantId: input.tenantId, providerId, model, goal, transcript: session.turns, cap });
    if (next.done || cap < 1) {
      session.status = 'ready';
      this.write(session);
      return { sessionId: session.sessionId, status: session.status, cap, questionNumber: 0, done: true };
    }
    session.turns.push({ question: next.question });
    this.write(session);
    return { sessionId: session.sessionId, status: session.status, cap, questionNumber: 1, question: next.question, done: false };
  }

  /** Records an answer to the outstanding question and asks the next one, unless the cap is reached. */
  public static async answer(input: AnswerInput): Promise<AnswerResult> {
    const session = this.read(input.tenantId, input.sessionId);
    if (session.status !== 'asking') throw fail('LOOP_GRILL_NOT_ASKING', `the session is ${session.status}`);
    const answer = typeof input.answer === 'string' ? input.answer.trim() : '';
    if (!answer) throw fail('LOOP_GRILL_ANSWER_REQUIRED');
    const outstanding = session.turns[session.turns.length - 1];
    if (!outstanding || outstanding.answer !== undefined) throw fail('LOOP_GRILL_NOT_ASKING', 'there is no outstanding question');

    outstanding.answer = answer;
    session.updatedAt = new Date().toISOString();

    // The cap is a hard limit enforced here: never ask more than `cap` questions.
    if (session.turns.length >= session.cap) {
      session.status = 'ready';
      this.write(session);
      return { sessionId: session.sessionId, status: session.status, answered: session.turns.length, questionNumber: session.turns.length, done: true };
    }

    const next = await currentAsker()({ tenantId: session.tenantId, providerId: session.providerId, model: session.model, goal: session.goal, transcript: session.turns, cap: session.cap });
    if (next.done) {
      session.status = 'ready';
      this.write(session);
      return { sessionId: session.sessionId, status: session.status, answered: session.turns.length, questionNumber: session.turns.length, done: true };
    }
    session.turns.push({ question: next.question });
    this.write(session);
    return { sessionId: session.sessionId, status: session.status, answered: session.turns.length - 1, questionNumber: session.turns.length, question: next.question, done: false };
  }

  /**
   * Drafts the task document from the goal plus the transcript, through `draftTaskDocument`, so the
   * loop's own parser is the boundary: a malformed draft is a refusal (`LOOP_GRILL_DRAFT_INVALID`),
   * never a returned file.
   */
  public static async finish(input: FinishInput): Promise<GoalDraftResult> {
    const session = this.read(input.tenantId, input.sessionId);
    if (session.status === 'drafted') throw fail('LOOP_GRILL_ALREADY_DRAFTED');

    const transcript = session.turns
      .map((turn, index) => `${index + 1}. Q: ${turn.question}\n   A: ${turn.answer ?? '(unanswered)'}`)
      .join('\n');
    const composedGoal = [session.goal, '', 'Clarifications from the operator:', transcript || '(none)'].join('\n');

    const { system, task } = buildGoalPrompt(
      session.repo,
      composedGoal,
      session.providerId,
      session.model,
      resolveLearning(session.tenantId),
      SkillInjectionService.advisoryForRole('drafter'),
    );
    const result = await draftTaskDocument({
      tenantId: session.tenantId,
      system,
      task,
      providerId: session.providerId,
      model: session.model,
      invalidCode: 'LOOP_GRILL_DRAFT_INVALID',
    });

    session.status = 'drafted';
    session.taskDocument = result.taskDocument;
    this.write(session);
    return result;
  }
}
