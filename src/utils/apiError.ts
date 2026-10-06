/**
 * One place that decides what a client is told when the service layer throws.
 *
 * ## What was wrong
 *
 * Seven route modules each carried their own copy of this:
 *
 *   const fail = (res, error) => res.status(409).json({
 *     code: error?.message, message: error?.message });
 *
 * That is two defects at once.
 *
 * 1. **Every** failure was reported as `409 Conflict`. A corrupt ledger, a filesystem
 *    error and a programming TypeError were all announced as a client-side conflict.
 *    A client obeying HTTP semantics would retry a request that had actually failed on
 *    the server, and an operator reading the status code would conclude the request was
 *    the problem when the service was.
 * 2. `error.message` was returned verbatim. For a domain error that string is a code,
 *    which is fine. For anything else it is whatever the runtime or the filesystem said,
 *    and those routinely embed absolute paths, internal identifiers and occasionally
 *    credential echoes. That is an information disclosure to every caller.
 *
 * The global handler had the same leak: it forwarded `err.message` for anything that
 * escaped the routes, and labelled every one of them a malformed context error.
 *
 * ## The rule
 *
 * A message is publishable only if this codebase wrote it. Anything not in the table
 * below is treated as an internal fault: it is logged in full, and the client receives a
 * stable code plus a correlation id it can quote. The correlation id is what makes the
 * log findable without telling the caller anything about the internals.
 */

import { randomUUID } from 'node:crypto';
import { OperationalError } from './operationalError';

export interface ClassifiedError {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
  /** Present only on 500s. Quote this to an operator; it reveals nothing itself. */
  incidentId?: string;
  /** True when the failure was not a recognised domain condition. */
  internal: boolean;
  /**
   * The raw message, for the log only. It is never serialised into a response; this is
   * how an operator gets the real cause while the client gets only the incident id.
   */
  originalMessage?: string;
}

interface DomainRule {
  status: number;
  message: string;
  retryAfterSeconds?: number;
}

/**
 * Built from the codes the service layer actually throws, not from a naming convention.
 * Each message is written here, so each is safe to publish.
 */
const DOMAIN_ERRORS: Readonly<Record<string, DomainRule>> = Object.freeze({
  // ── Missing resources ──────────────────────────────────────────────────────
  AGENT_RUN_NOT_FOUND: { status: 404, message: 'No such agent run.' },
  APPROVAL_NOT_FOUND: { status: 404, message: 'No such approval.' },
  AUTONOMY_SESSION_NOT_FOUND: { status: 404, message: 'No such autonomy session.' },
  BACKUP_FILE_NOT_FOUND: { status: 404, message: 'No such backup file.' },
  BACKUP_NOT_FOUND: { status: 404, message: 'No such backup.' },
  BUILD_OUTPUT_NOT_FOUND: { status: 404, message: 'No build output for this project.' },
  CLIENT_WORKSPACE_NOT_FOUND: { status: 404, message: 'No such client workspace.' },
  COMPLETION_TASK_NOT_FOUND: { status: 404, message: 'No such completion task.' },
  EXECUTION_MANIFEST_NOT_FOUND: { status: 404, message: 'No execution manifest for this project.' },
  FACTORY_JOB_NOT_FOUND: { status: 404, message: 'No such factory job.' },
  FAILURE_NOT_FOUND: { status: 404, message: 'No such failure record.' },
  HANDOVER_NOT_FOUND: { status: 404, message: 'No such handover.' },
  HOSTED_DEPLOYMENT_NOT_FOUND: { status: 404, message: 'No such hosted deployment.' },
  HOSTED_ROLLBACK_TARGET_NOT_FOUND: { status: 404, message: 'No such rollback target.' },
  HOSTED_SOURCE_ARTIFACT_NOT_FOUND: { status: 404, message: 'No source artifact for this deployment.' },
  HOSTED_TARGET_NOT_FOUND: { status: 404, message: 'No such deployment target.' },
  MODEL_PROVIDER_NOT_FOUND: { status: 404, message: 'No such model provider.' },
  OBSERVATION_NOT_FOUND: { status: 404, message: 'No such observation.' },
  PROJECT_NOT_FOUND: { status: 404, message: 'No such project.' },
  QUEUE_JOB_NOT_FOUND: { status: 404, message: 'No such queue job.' },
  REPOSITORY_CONTEXT_NOT_FOUND: { status: 404, message: 'No repository context for this project.' },
  SANDBOX_POLICY_NOT_FOUND: { status: 404, message: 'No such sandbox policy.' },
  TASK_DOCUMENT_NOT_FOUND: { status: 404, message: 'No such task document.' },
  LOOP_RUN_NOT_FOUND: { status: 404, message: 'No such loop run.' },
  WORKTREE_NOT_FOUND: { status: 404, message: 'No such worktree.' },

  // ── Policy and state preconditions raised by the orchestration services ────
  APPROVAL_REQUIRED: { status: 403, message: 'This action requires an approval decision first.' },
  AUTONOMY_ACTION_NOT_ALLOWED: { status: 403, message: 'This action is not permitted under the autonomy policy.' },
  COMPLETION_TASKS_PENDING: { status: 409, message: 'Completion tasks are still pending.' },
  INVALID_FACTORY_TRANSITION: { status: 409, message: 'That status transition is not allowed for a factory job.' },
  EXECUTION_MODE_UNSUPPORTED: { status: 409, message: 'The doctrine asks for an execution mode this driver does not implement.' },
  GATE_REFUSED: { status: 409, message: 'A stage gate refused to continue; the recorded run names the gate and the reason.' },
  REPO_NOT_CLEAN: { status: 409, message: 'The repository has uncommitted changes. The loop starts only from a clean tree.' },
  ATTEMPT_CAP_REACHED: { status: 409, message: 'This unit has used every attempt doctrine allows.' },
  LOOP_RUN_INCOMPATIBLE: { status: 409, message: 'That run cannot be resumed: the task document, the doctrine or the repository changed after it started.' },
  HARD_STOP: { status: 409, message: 'The run reached one of its hard stops and ended rather than continuing.' },
  AGENT_DEPENDENCY_NOT_FOUND: { status: 404, message: 'No such agent dependency.' },
  MODEL_PROVIDER_DISCOVERY_FAILED: { status: 502, message: 'The provider model list could not be retrieved.' },
  MODEL_PROVIDER_REDIRECT_NOT_ALLOWED: { status: 502, message: 'The provider redirected the request, which is not permitted.' },
  MODEL_PROVIDER_REQUEST_FAILED: { status: 502, message: 'The provider request did not succeed.' },

  // ── Ledger structural faults. The service cannot interpret its own data. ───
  GATE_NOT_IMPLEMENTED: { status: 500, message: 'A stage gate named by the doctrine has no implementation.' },
  LEDGER_COLLECTION_INVALID: { status: 500, message: 'The ledger could not be interpreted.', retryAfterSeconds: 5 },
  LEDGER_COLLECTION_UNKNOWN: { status: 500, message: 'The ledger contains an unknown collection.', retryAfterSeconds: 5 },
  LEDGER_VERSION_UNSUPPORTED: { status: 500, message: 'The ledger version is not supported by this build.', retryAfterSeconds: 5 },
  LEDGER_VERSION_FUTURE: { status: 500, message: 'The ledger was written by a newer build and cannot be safely read.', retryAfterSeconds: 5 },
  LEDGER_VERSION_INVALID: { status: 500, message: 'The ledger version is not a valid version number.', retryAfterSeconds: 5 },

  // ── Caller supplied something invalid ──────────────────────────────────────
  AGENT_TASK_IDS_MUST_BE_UNIQUE: { status: 400, message: 'Task ids must be unique within an agent run.' },
  AGENT_TASKS_REQUIRED: { status: 400, message: 'At least one task is required.' },
  FILE_PATH_REQUIRED: { status: 400, message: 'A file path is required.' },
  PATH_MISSING: { status: 400, message: 'A path is required.' },
  MODEL_PROVIDER_BASE_URL_REQUIRED: { status: 400, message: 'A base URL is required for this provider kind.' },
  MODEL_PROVIDER_ID_REQUIRED: { status: 400, message: 'A provider id is required.' },
  MODEL_PROVIDER_MALFORMED_URL: { status: 400, message: 'The provider URL is not a valid URL.' },
  MODEL_PROVIDER_MODEL_REQUIRED: { status: 400, message: 'A model name is required.' },
  MODEL_PROVIDER_SYSTEM_PROMPT_REQUIRED: { status: 400, message: 'A system prompt is required.' },
  MODEL_PROVIDER_TASK_REQUIRED: { status: 400, message: 'A task is required.' },
  MODEL_PROVIDER_KIND_NOT_RECOGNIZED: { status: 400, message: 'That model provider kind is not supported.' },
  MODEL_PROVIDER_URL_MALFORMED_URL: { status: 400, message: 'The provider URL is not a valid URL.' },
  MODEL_PROVIDER_URL_INVALID: { status: 400, message: 'The provider URL is not permitted.' },
  MODEL_PROVIDER_HOST_NOT_ALLOWED: { status: 403, message: 'That provider host is not on the allowlist.' },
  MODEL_PROVIDER_ADDRESS_NOT_ALLOWED: { status: 403, message: 'That provider address is not permitted for outbound calls.' },

  // A niche the platform recognises but cannot serve. 403 rather than 404: the niche exists
  // and is a legitimate part of the taxonomy, the service is declining to act on it. It is
  // NOT a 400, because the caller's payload is correct -- reporting a bad request here would
  // send an integrator to fix a document that was never the problem. It is NOT a 501 either,
  // because this is a product boundary rather than an absent implementation detail, and 501
  // invites a retry that will never succeed.
  //
  // The message is fixed and public: it must not echo the caller's payload, and it must not
  // enumerate which niches ARE served, because that is an invitation to probe the boundary.
  // The detailed reason travels in the `details` field of the thrown response, which the
  // handler classifies rather than forwards.
  NICHE_NOT_SERVED: { status: 403, message: 'This platform does not serve that industry niche.' },
  OUTCOME_NOTE_REQUIRED: { status: 400, message: 'An outcome note is required.' },
  PROJECT_ID_REQUIRED: { status: 400, message: 'A project id is required.' },
  READINESS_CRITERION_NOT_RECOGNIZED: { status: 400, message: 'That readiness criterion is not recognized.' },
  SANDBOX_SECRET_REFERENCE_INVALID: { status: 400, message: 'That secret reference is not valid.' },
  TENANT_CONTEXT_REQUIRED: { status: 400, message: 'A tenant context is required.' },

  // ── Refused by policy. The request was understood and denied on purpose. ────
  EXECUTION_SOURCE_OUTSIDE_APPROVED_WORKSPACE: { status: 403, message: 'The source path is outside the approved workspace.' },
  MODEL_PROVIDER_SECRET_REF_NOT_ALLOWED: { status: 403, message: 'That secret reference is not permitted for outbound calls.' },
  MODEL_PROVIDER_URL_SCHEME_NOT_ALLOWED: { status: 403, message: 'That URL scheme is not permitted for outbound calls.' },
  PATH_DOES_NOT_EXIST: { status: 404, message: 'That path does not exist.' },
  PATH_NOT_A_DIRECTORY: { status: 400, message: 'That path is not a directory.' },
  REPOSITORY_OUTSIDE_APPROVED_WORKSPACE: { status: 403, message: 'The repository is outside the approved workspace.' },
  REPOSITORY_SOURCE_OUTSIDE_APPROVED_WORKSPACE: { status: 403, message: 'The repository source is outside the approved workspace.' },
  SANDBOX_ALLOWLIST_REQUIRED: { status: 403, message: 'A sandbox allowlist is required for this execution.' },
  SANDBOX_SOURCE_OUTSIDE_APPROVED_WORKSPACE: { status: 403, message: 'The sandbox source is outside the approved workspace.' },
  AUTONOMY_APPROVAL_REQUIRED: { status: 403, message: 'This step requires an autonomy approval decision first.' },

  // The path guard takes its code as a parameter, so these never appear as a literal in a
  // `throw new Error('...')` and are easy to miss when auditing which codes are covered.
  // Each names a distinct call site's boundary; all of them are the same decision.
  PATH_OUTSIDE_APPROVED_WORKSPACE: { status: 403, message: 'That path is outside the approved workspace.' },
  FILE_OUTSIDE_REPOSITORY: { status: 403, message: 'That file is outside the repository.' },
  PROJECT_OUTSIDE_APPROVED_WORKSPACE: { status: 403, message: 'The project repository is outside the approved workspace.' },
  QUALITY_REPOSITORY_OUTSIDE_APPROVED_WORKSPACE: { status: 403, message: 'The repository is outside the approved workspace.' },
  PATH_UNRESOLVABLE: { status: 400, message: 'That path could not be resolved.' },

  // ── Caller sent a payload that failed validation ───────────────────────────
  INVALID_EVIDENCE: { status: 400, message: 'The evidence payload is not valid.' },
  INVALID_FACTORY_JOB: { status: 400, message: 'A factory job requires a title, a problem, and a desired outcome.' },
  INVALID_PRODUCT_BRIEF: { status: 400, message: 'The product brief is not valid.' },
  INVALID_REPAIR_LOOP: { status: 400, message: 'The repair loop payload is not valid.' },
  INVALID_QUALITY_SNAPSHOT: { status: 400, message: 'A quality snapshot requires a product name, a numeric score, dimensions, and evidence kinds.' },
  INVALID_CONTEXT_REFRESH: { status: 400, message: 'A context refresh requires a repository and a source path.' },
  INVALID_PATTERN_PROMOTION: { status: 400, message: 'A pattern promotion requires a repository, a pattern, and an adapter.' },
  MALFORMED_CONTEXT: { status: 400, message: 'The request context is malformed.' },

  // ── State preconditions. The request is valid; the resource is not ready. ──
  APPROVAL_ALREADY_DECIDED: { status: 409, message: 'That approval has already been decided.' },
  AUTONOMY_COST_BUDGET_EXCEEDED: { status: 409, message: 'The autonomy cost budget is exhausted.' },
  AUTONOMY_SESSION_NOT_ACTIVE: { status: 409, message: 'The autonomy session is not active.' },
  AUTONOMY_STEP_BUDGET_EXCEEDED: { status: 409, message: 'The autonomy step budget is exhausted.' },
  DELIVERY_EVIDENCE_REQUIRED: { status: 409, message: 'Delivery evidence is required before this step.' },
  HOSTED_DEPLOYMENT_APPROVAL_REQUIRED: { status: 409, message: 'This deployment requires an approval decision first.' },
  HOSTED_TARGET_SECRET_REFERENCE_REQUIRED: { status: 409, message: 'This target requires a secret reference.' },
  PASSED_PROOF_REQUIRES_OBSERVATION: { status: 409, message: 'A passed proof requires an observation.' },
  PASSED_VERIFICATION_REQUIRED: { status: 409, message: 'Verification must pass before this step.' },
  PREVIEW_REQUIRED: { status: 409, message: 'A preview is required before this step.' },
  RELEASE_ENTRYPOINT_NOT_FOUND: { status: 409, message: 'No release entrypoint is configured for this project.' },
  ROLLBACK_TARGET_UNHEALTHY: { status: 409, message: 'The rollback target is not healthy.' },

  // ── Upstream or local infrastructure. The caller may retry. ────────────────
  LEDGER_ANOTHER_WRITER_ACTIVE: { status: 503, message: 'The ledger is held by another writer. Retry shortly.', retryAfterSeconds: 5 },
  MODEL_PROVIDER_NOT_AVAILABLE: { status: 503, message: 'The model provider is unavailable. Retry shortly.', retryAfterSeconds: 30 },
  MODEL_PROVIDER_REQUEST_TIMEOUT: { status: 503, message: 'The model provider timed out. Retry shortly.', retryAfterSeconds: 30 },
  MODEL_PROVIDER_REQUEST_UNSUPPORTED: { status: 503, message: 'The model provider rejected the request shape.', retryAfterSeconds: 30 },
  RESOURCE_EXHAUSTED: { status: 503, message: 'The host is out of memory or load. Retry shortly.', retryAfterSeconds: 30 },
  ROLLBACK_TARGET_NOT_FOUND: { status: 409, message: 'No rollback target is available.' },

  // ── Repository is not usable as a repository ───────────────────────────────
  AGENT_REPOSITORY_NOT_GIT: { status: 400, message: 'That path is not a git repository.' },
  EXECUTION_SOURCE_NOT_GIT: { status: 400, message: 'The execution source is not a git repository.' },
  PROJECT_REPOSITORY_NOT_GIT: { status: 400, message: 'The project repository is not a git repository.' },
  REPOSITORY_SOURCE_NOT_GIT: { status: 400, message: 'The repository source is not a git repository.' },
  SANDBOX_SOURCE_NOT_FOUND: { status: 404, message: 'No such sandbox source.' },
});

/** Upstream answers we deliberately refuse to relay. Only a summary reaches the client. */
const UPSTREAM_SIZE_CODES: Readonly<Record<string, DomainRule>> = Object.freeze({
  MODEL_PROVIDER_RESPONSE_TOO_LARGE: { status: 502, message: 'The provider response exceeded the permitted size.' },
  MODEL_PROVIDER_MODEL_LIST_TOO_LARGE: { status: 502, message: 'The provider model list exceeded the permitted size.' },
  MODEL_PROVIDER_INVALID_RESPONSE: { status: 502, message: 'The provider returned a response that could not be parsed.' },
  BACKUP_CHECKSUM_MISMATCH: { status: 409, message: 'The backup checksum does not match the ledger.' },
});

const ALL_DOMAIN: Readonly<Record<string, DomainRule>> = Object.freeze({ ...DOMAIN_ERRORS, ...UPSTREAM_SIZE_CODES });

/** Codes the ledger raises when it is unusable. The service cannot honestly serve traffic. */
const LEDGER_UNAVAILABLE: ReadonlySet<string> = new Set([
  'FACTORY_LEDGER_NOT_FOUND',
  'LEDGER_ROOT_NOT_AN_OBJECT',
  'LEDGER_RECORD_ID_REQUIRED',
  // A registry record that cannot be decoded means the service does not know who its
  // tenants are. That is the same class of fault as an unreadable ledger -- the process
  // cannot honestly serve -- so it belongs with the codes that refuse traffic rather than
  // degrading to a generic 500 with no operator signal.
  'TENANT_RECORD_ID_INVALID',
]);

/**
 * Turns anything thrown into a response body that is safe to publish.
 *
 * `fallbackCode` names the operation, so an unrecognised internal fault still tells the
 * caller which call failed without describing the fault.
 */
export function classifyApiError(error: unknown, fallbackCode = 'OPERATION_FAILED'): ClassifiedError {
  // Typed operational failures already carry a vetted status and a written message.
  if (error instanceof OperationalError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
      details: error.details,
      internal: error.status >= 500,
    };
  }

  const message = typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error);

  // Several call sites raise "CODE: human sentence". The code is the machine-readable
  // part and is looked up in the table; the sentence is discarded, because a sentence
  // invented at a call site is exactly the kind of text that leaks internals. If the
  // leading code is not in the table the whole thing is unrecognised and fails closed.
  const colon = message.indexOf(':');
  const candidate = colon > 0 ? message.slice(0, colon).trim() : message;
  const rule = ALL_DOMAIN[candidate];
  if (rule) {
    return { status: rule.status, code: candidate, message: rule.message, retryAfterSeconds: rule.retryAfterSeconds, internal: rule.status >= 500 };
  }

  if (LEDGER_UNAVAILABLE.has(candidate)) {
    return { status: 503, code: candidate, message: 'The ledger is unavailable. Retry shortly.', retryAfterSeconds: 5, internal: true };
  }

  // Not a domain condition. Do not describe it.
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'The service could not complete this request. Quote the incident id when reporting this.',
    incidentId: randomUUID(),
    internal: true,
    originalMessage: message,
  };
}

export interface ErrorResponseBody {
  status: 'error';
  code: string;
  message: string;
  incidentId?: string;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
}

/** The body only. `originalMessage` is deliberately not part of it. */
export function toErrorBody(classified: ClassifiedError): ErrorResponseBody {
  const body: ErrorResponseBody = {
    status: 'error',
    code: classified.code,
    message: classified.message,
  };
  if (classified.incidentId) body.incidentId = classified.incidentId;
  if (classified.retryAfterSeconds) body.retryAfterSeconds = classified.retryAfterSeconds;
  if (classified.details) body.details = classified.details;
  return body;
}

/** Test and diagnostics helper: the codes this module will echo back verbatim. */
export function knownDomainErrorCodes(): string[] {
  return Object.keys(ALL_DOMAIN);
}
