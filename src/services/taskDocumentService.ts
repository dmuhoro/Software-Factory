import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Task-document input contract.
 *
 * This is the single document Daniel hands in. It is markdown so a human can write it, read it,
 * and execute every step of it by hand; it is parsed strictly so the loop can refuse anything
 * ambiguous instead of guessing what the author meant.
 *
 * Fail-closed rules: an unknown section, a duplicate milestone, a dependency on a milestone that
 * does not exist, a cycle, a milestone with no acceptance criterion, and a milestone too large to
 * be one independently mergeable unit are all refusals at parse time — before any work starts.
 */

export type SplitMode = 'milestone' | 'criterion';

export interface TaskCriterion {
  id: string;
  text: string;
  /** Ground-truth command proving this criterion. Executed, never narrated. */
  check?: string;
}

export interface TaskMilestone {
  id: string;
  title: string;
  independent: boolean;
  dependsOn: string[];
  split: SplitMode;
  /** Conventional-commit type for every unit this milestone produces. */
  type: CommitType;
  /** Milestone-level verification command; falls back to the document, then the repo profile. */
  verify?: string;
  criteria: TaskCriterion[];
}

export interface TaskDocument {
  title: string;
  goal: string;
  constraints: string[];
  models: Record<string, string>;
  defaultVerify?: string;
  milestones: TaskMilestone[];
  sourcePath?: string;
  sourceHash: string;
}

export interface WorkUnit {
  id: string;
  milestoneId: string;
  title: string;
  criteria: TaskCriterion[];
  dependsOn: string[];
  type: CommitType;
  verify?: string;
}

export interface DecomposeOptions {
  maxAcceptanceCriteriaPerMilestone: number;
}

const KNOWN_SECTIONS = new Set(['Goal', 'Constraints', 'Models', 'Verification', 'Milestones']);
const MILESTONE_HEADING = /^###\s+([A-Za-z][A-Za-z0-9_-]{0,31})\s*:\s*(.+)$/;
const FIELD_LINE = /^(independent|depends|split|verify|type)\s*:\s*(.+)$/i;
export const COMMIT_TYPES = ['feat', 'fix', 'docs', 'refactor', 'test', 'chore'] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];
const CRITERION = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$/;
const NESTED_CHECK = /^\s+[-*]\s*check\s*:\s*(.+)$/i;
const MODEL_LINE = /^models\.([a-z][a-z0-9-]{1,31})\s*:\s*(.+)$/;

function parseError(detail: string): Error {
  return new Error(`TASK_DOCUMENT_INVALID:${detail}`);
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function parseTaskDocument(markdown: string, sourcePath?: string): TaskDocument {
  if (typeof markdown !== 'string' || !markdown.trim()) throw parseError('document is empty');
  const lines = markdown.split(/\r?\n/);

  let title = '';
  let goal = '';
  const constraints: string[] = [];
  const models: Record<string, string> = {};
  let defaultVerify: string | undefined;
  const milestones: TaskMilestone[] = [];

  let section = '';
  let milestone: TaskMilestone | undefined;
  let lastCriterion: TaskCriterion | undefined;
  let sawMilestoneSection = false;
  let sawH1 = false;

  const endMilestone = (): void => {
    if (milestone) {
      if (!milestone.criteria.length) throw parseError(`milestone ${milestone.id} has no acceptance criterion`);
      milestones.push(milestone);
      milestone = undefined;
      lastCriterion = undefined;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('# ')) {
      const heading = trimmed.slice(2).trim();
      if (sawH1) throw parseError(`more than one top-level heading (line ${index + 1})`);
      sawH1 = true;
      if (!heading.toLowerCase().startsWith('task:')) throw parseError('the single top-level heading must be "# Task: <title>"');
      title = heading.slice(5).trim();
      if (!title) throw parseError('title after "# Task:" is empty');
      continue;
    }

    if (trimmed.startsWith('## ')) {
      endMilestone();
      section = trimmed.slice(3).trim();
      if (!KNOWN_SECTIONS.has(section)) throw parseError(`unknown section "## ${section}" (line ${index + 1})`);
      if (section === 'Milestones') sawMilestoneSection = true;
      continue;
    }

    if (trimmed.startsWith('### ')) {
      if (section !== 'Milestones') throw parseError(`milestone heading outside "## Milestones" (line ${index + 1})`);
      endMilestone();
      const match = trimmed.match(MILESTONE_HEADING);
      if (!match) throw parseError(`milestone heading must be "### <id>: <title>" (line ${index + 1})`);
      milestone = {
        id: match[1],
        title: match[2].trim(),
        independent: true,
        dependsOn: [],
        split: 'milestone',
        type: 'feat',
        criteria: [],
      };
      if (milestones.some((existing) => existing.id === milestone!.id)) throw parseError(`duplicate milestone id ${milestone.id}`);
      if (!milestone.title) throw parseError(`milestone ${milestone.id} has an empty title`);
      continue;
    }

    if (trimmed.startsWith('#')) throw parseError(`unexpected heading "${trimmed.slice(0, 40)}" (line ${index + 1})`);

    if (section === 'Goal') {
      goal = goal ? `${goal}\n${trimmed}` : trimmed;
      continue;
    }

    if (section === 'Constraints') {
      if (!trimmed.startsWith('- ')) throw parseError(`constraint lines must be list items (line ${index + 1})`);
      constraints.push(trimmed.slice(2).trim());
      continue;
    }

    if (section === 'Models') {
      const match = trimmed.match(MODEL_LINE);
      if (!match) throw parseError(`model lines must be "models.<role>: <providerId>/<model>" (line ${index + 1})`);
      models[match[1]] = match[2].trim();
      continue;
    }

    if (section === 'Verification') {
      if (defaultVerify) throw parseError('the Verification section may declare only one command');
      defaultVerify = trimmed;
      continue;
    }

    if (section === 'Milestones') {
      if (!milestone) throw parseError(`content outside a milestone (line ${index + 1})`);

      // Matched against the raw line: the indentation is what separates a check from a criterion.
      const nested = line.match(NESTED_CHECK);
      if (nested) {
        if (!lastCriterion) throw parseError(`"check:" without a preceding criterion (line ${index + 1})`);
        if (lastCriterion.check) throw parseError(`criterion ${lastCriterion.id} already has a check`);
        lastCriterion.check = nested[1].trim();
        if (!lastCriterion.check) throw parseError(`criterion ${lastCriterion.id} has an empty check`);
        continue;
      }

      const criterion = trimmed.match(CRITERION);
      if (criterion) {
        const text = criterion[2].trim();
        if (!text) throw parseError(`acceptance criterion is empty (line ${index + 1})`);
        lastCriterion = { id: `${milestone.id}-c${milestone.criteria.length + 1}`, text };
        milestone.criteria.push(lastCriterion);
        continue;
      }

      const field = trimmed.match(FIELD_LINE);
      if (field) {
        const key = field[1].toLowerCase();
        const value = field[2].trim();
        if (key === 'independent') {
          if (!/^(true|false)$/i.test(value)) throw parseError(`${milestone.id}: independent must be true or false`);
          milestone.independent = value.toLowerCase() === 'true';
        } else if (key === 'depends') {
          const deps = value.split(',').map((item) => item.trim()).filter(Boolean);
          if (!deps.length) throw parseError(`${milestone.id}: depends lists nothing`);
          for (const dep of deps) if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(dep)) throw parseError(`${milestone.id}: bad dependency id "${dep}"`);
          milestone.dependsOn = [...new Set(deps)];
        } else if (key === 'split') {
          if (!/^(milestone|criterion)$/i.test(value)) throw parseError(`${milestone.id}: split must be milestone or criterion`);
          milestone.split = value.toLowerCase() as SplitMode;
        } else if (key === 'verify') {
          if (!value) throw parseError(`${milestone.id}: empty verify command`);
          milestone.verify = value;
        } else if (key === 'type') {
          if (!(COMMIT_TYPES as readonly string[]).includes(value)) throw parseError(`${milestone.id}: type must be one of ${COMMIT_TYPES.join(', ')}`);
          milestone.type = value as CommitType;
        }
        continue;
      }

      throw parseError(`unrecognised line inside milestone ${milestone.id} (line ${index + 1}): "${trimmed.slice(0, 60)}"`);
    }

    throw parseError(`content outside any section (line ${index + 1})`);
  }
  endMilestone();

  if (!sawH1) throw parseError('missing "# Task: <title>" heading');
  if (!goal.trim()) throw parseError('## Goal is required and must be non-empty');
  if (!sawMilestoneSection) throw parseError('## Milestones is required');
  if (!milestones.length) throw parseError('no milestones declared');

  const ids = new Set(milestones.map((item) => item.id));
  for (const item of milestones) {
    for (const dep of item.dependsOn) {
      if (dep === item.id) throw parseError(`${item.id} depends on itself`);
      if (!ids.has(dep)) throw parseError(`${item.id} depends on unknown milestone ${dep}`);
    }
  }
  detectCycle(milestones);

  // Checked here rather than at resolution time so the refusal carries the document's own line:
  // a brief that names `models.implementer: local` with no separator is a malformed instruction,
  // not a model the loop should try to guess at.
  for (const [role, value] of Object.entries(models)) {
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1) {
      throw parseError(`models.${role} must be "<providerId>/<model>", got "${value}"`);
    }
    const providerId = value.slice(0, slash);
    const model = value.slice(slash + 1);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(providerId)) throw parseError(`models.${role} provider "${providerId}" is not a lowercase provider id`);
    if (!model.trim() || /\s/.test(model) || model.length > 128) throw parseError(`models.${role} model "${model}" is not a valid model name`);
  }

  return {
    title,
    goal,
    constraints,
    models,
    defaultVerify,
    milestones,
    sourcePath,
    sourceHash: sha256(markdown),
  };
}

function detectCycle(milestones: TaskMilestone[]): void {
  const byId = new Map(milestones.map((item) => [item.id, item]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: string[]): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') throw parseError(`dependency cycle: ${[...trail, id].join(' -> ')}`);
    state.set(id, 'visiting');
    const milestone = byId.get(id)!;
    for (const dep of milestone.dependsOn) visit(dep, [...trail, id]);
    state.set(id, 'done');
  };
  for (const milestone of milestones) visit(milestone.id, []);
}

export function loadTaskDocument(file: string): TaskDocument {
  if (!fs.existsSync(file)) throw new Error(`TASK_DOCUMENT_NOT_FOUND:${file}`);
  return parseTaskDocument(fs.readFileSync(file, 'utf8'), file);
}

/**
 * Decomposition: a task document becomes the smallest independently mergeable units the loop
 * will run. One unit = one plan→implement→verify→commit→report cycle = exactly one commit.
 *
 * A milestone is one unit by default. `split: criterion` makes each acceptance criterion its own
 * unit, run in order, for milestones whose criteria touch different surfaces. A milestone whose
 * criteria count exceeds the doctrine cap is refused rather than silently committed as one blob:
 * that cap is the enforcement behind "25+ small commits a day" — big milestones are a parse error.
 */
export function decompose(document: TaskDocument, options: DecomposeOptions): WorkUnit[] {
  const cap = options.maxAcceptanceCriteriaPerMilestone;
  if (!Number.isInteger(cap) || cap < 1) throw parseError('maxAcceptanceCriteriaPerMilestone must be a positive integer');

  const units: WorkUnit[] = [];
  const unitsByMilestone = new Map<string, string[]>();

  for (const milestone of document.milestones) {
    if (milestone.criteria.length > cap) {
      throw parseError(`milestone ${milestone.id} declares ${milestone.criteria.length} acceptance criteria; the cap is ${cap}. Split it into smaller milestones so each produces its own verified commit.`);
    }
    const ids: string[] = [];
    if (milestone.split === 'criterion') {
      milestone.criteria.forEach((criterion, index) => {
        const unit: WorkUnit = {
          id: criterion.id,
          milestoneId: milestone.id,
          title: `${milestone.title} — ${criterion.text}`,
          criteria: [criterion],
          dependsOn: index === 0 ? [] : [milestone.criteria[index - 1].id],
          type: milestone.type,
          verify: milestone.verify ?? document.defaultVerify,
        };
        units.push(unit);
        ids.push(unit.id);
      });
    } else {
      const unit: WorkUnit = {
        id: milestone.id,
        milestoneId: milestone.id,
        title: milestone.title,
        criteria: milestone.criteria,
        dependsOn: [],
        type: milestone.type,
        verify: milestone.verify ?? document.defaultVerify,
      };
      units.push(unit);
      ids.push(unit.id);
    }
    unitsByMilestone.set(milestone.id, ids);
  }

  // Cross-milestone edges are lifted onto units. A milestone-level dependency blocks every unit
  // it produced, so a STUCK dependency stops dependent work instead of running past it.
  for (const milestone of document.milestones) {
    const targets = unitsByMilestone.get(milestone.id)!;
    const sources = milestone.dependsOn.flatMap((dep) => unitsByMilestone.get(dep) ?? []);
    for (const target of targets) {
      const unit = units.find((item) => item.id === target)!;
      unit.dependsOn = [...new Set([...unit.dependsOn, ...sources])];
    }
  }

  const unitIds = new Set(units.map((item) => item.id));
  for (const unit of units) {
    for (const dep of unit.dependsOn) if (!unitIds.has(dep)) throw parseError(`unit ${unit.id} depends on unknown unit ${dep}`);
  }
  detectUnitCycle(units);
  return units;
}

function detectUnitCycle(units: WorkUnit[]): void {
  const byId = new Map(units.map((item) => [item.id, item]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: string[]): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') throw parseError(`unit dependency cycle: ${[...trail, id].join(' -> ')}`);
    state.set(id, 'visiting');
    for (const dep of byId.get(id)!.dependsOn) visit(dep, [...trail, id]);
    state.set(id, 'done');
  };
  for (const unit of units) visit(unit.id, []);
}
