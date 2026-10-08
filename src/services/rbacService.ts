/**
 * Resource-scoped RBAC: principal → role → permission → resource.
 *
 * Phase 3 answered "what may this *credential* do", derived from the request. This
 * answers "what may this *role* do, and to which resource". Both must pass. A
 * credential scoped to `loop:write` held by an `auditor` still cannot start a run,
 * because the auditor has no such permission; and an `operator` whose binding covers
 * one repository cannot touch another, because the binding does not reach it.
 *
 * ## Why the roles are a closed set
 *
 * Four roles, each with a fixed permission set. An unrecognised role resolves to no
 * permissions at all, not to some sensible default: a typo in a role name must not
 * silently grant access, and "no permissions" is the only default that cannot.
 *
 * ## Why resource scope is part of the binding
 *
 * A permission that applies to every repository is a permission an operator granted
 * once and forgot. A binding names the repositories it covers, so "may cancel runs in
 * the staging repo" is expressible, and the alternative — a global cancel right — is
 * not the default anyone falls into.
 *
 * ## Where this is enforced
 *
 * `requirePermission` is the guard. It is called by routes, and it reads the principal
 * that `tenantAuthMiddleware` already resolved, so there is one place that decides who
 * the caller is and one place that decides what they may do with it.
 */

import type { AuthenticatedPrincipal } from '../api/middleware/tenantAuth';
import { TelemetryLogger } from '../utils/telemetryLogger';

/** The closed role set. An unrecognised role is no role, and no role is no permission. */
export const ROLES = ['admin', 'operator', 'auditor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_SET = new Set<string>(ROLES);

/** The closed permission set. Anything not listed here is not a permission. */
export const PERMISSIONS = [
  'loop:read',
  'loop:submit',
  'loop:cancel',
  'credential:provision',
  'webhook:manage',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET = new Set<string>(PERMISSIONS);

/**
 * The fixed permission set per role.
 *
 * Deliberately explicit rather than derived, so the table can be read and argued with.
 * `admin` holds everything; each role below it holds strictly less.
 */
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [...PERMISSIONS],
  operator: ['loop:read', 'loop:submit', 'loop:cancel', 'webhook:manage', 'audit:read'],
  auditor: ['loop:read', 'audit:read'],
  viewer: ['loop:read'],
};

/** The wildcard resource: a binding that covers every repository. */
export const ANY_RESOURCE = '*';

/**
 * A binding of one principal to one role, optionally limited to named resources.
 *
 * `resources` of `[ANY_RESOURCE]` is a binding that reaches everywhere. It is allowed
 * because an admin genuinely needs it, and it is not the default because everyone else
 * has to name what they were granted.
 */
export interface RoleBinding {
  principalId: string;
  role: Role;
  /** Repository ids (or paths) this binding covers. Empty grants nothing, not everything. */
  resources: string[];
  createdAt: string;
}

/** Why a permission check refused. Named so a 403 carries a reason. */
export const RBAC_REFUSALS = {
  NO_BINDING: 'RBAC_NO_ROLE_BINDING',
  UNKNOWN_ROLE: 'RBAC_ROLE_UNKNOWN',
  PERMISSION_DENIED: 'RBAC_PERMISSION_DENIED',
  RESOURCE_OUT_OF_SCOPE: 'RBAC_RESOURCE_OUT_OF_SCOPE',
} as const;

export interface RbacDecision {
  allowed: boolean;
  reason?: string;
  /** The permission that was required, for the audit trail. */
  required?: Permission;
}

/** A binding store. In memory, and honest about what a restart costs. */
const BINDINGS = new Map<string, RoleBinding>();

/** How a principal's role is determined when no explicit binding exists. */
export class RbacService {
  /**
   * Binds a principal to a role.
   *
   * An empty `resources` list is refused: a binding that names nothing must not be
   * stored as a binding that means everything, which is the exact inversion this model
   * exists to prevent.
   */
  public static bind(principalId: string, role: Role, resources: string[]): RoleBinding {
    if (!ROLE_SET.has(role)) throw new Error(`role '${role}' is not one of ${ROLES.join(', ')}`);
    if (!Array.isArray(resources) || resources.length === 0) {
      throw new Error('A role binding must name at least one resource; use the wildcard to cover everything');
    }
    const binding: RoleBinding = { principalId, role, resources: [...resources], createdAt: new Date().toISOString() };
    BINDINGS.set(principalId, binding);
    return binding;
  }

  public static unbind(principalId: string): void {
    BINDINGS.delete(principalId);
  }

  public static binding(principalId: string): RoleBinding | undefined {
    return BINDINGS.get(principalId);
  }

  /**
   * The permissions a role holds, or none at all for an unrecognised role.
   *
   * Returns a copy so a caller cannot mutate the table through the result.
   */
  public static permissionsFor(role: unknown): Permission[] {
    if (typeof role !== 'string' || !ROLE_SET.has(role)) return [];
    return [...(ROLE_PERMISSIONS[role as Role] ?? [])];
  }

  /**
   * The role a principal holds.
   *
   * An explicit binding wins. Without one, the root credential is an `admin` and a
   * scoped credential is a `viewer`: the narrowest role that can still see something.
   *
   * A principal whose kind this cannot interpret holds no role at all. That is
   * defensive — the middleware only ever produces `root` or `scoped` — but a refusal
   * reason that could never fire would be a claim of protection this code does not
   * provide, so the unrecognised case is refused rather than defaulted.
   */
  public static roleFor(principal: AuthenticatedPrincipal): Role | undefined {
    const explicit = BINDINGS.get(principal.credentialId ?? principal.tenantId);
    if (explicit) return explicit.role;
    if (principal.kind === 'root') return 'admin';
    if (principal.kind === 'scoped') return 'viewer';
    return undefined;
  }

  /**
   * Decides whether a principal may perform `permission` on `resource`.
   *
   * Both halves must pass. The permission must be in the role's set, and the binding
   * must reach the resource. Refusing returns the reason, so a 403 can say which of the
   * two it was rather than leaving the caller to guess.
   */
  public static check(principal: AuthenticatedPrincipal, permission: Permission, resource?: string): RbacDecision {
    if (!PERMISSION_SET.has(permission)) {
      return { allowed: false, reason: RBAC_REFUSALS.PERMISSION_DENIED, required: permission };
    }
    const role = this.roleFor(principal);
    if (!role) {
      TelemetryLogger.warn('RBAC refused: principal holds no role', { metadata: { tenantId: principal.tenantId, credentialId: principal.credentialId ?? null, permission } });
      return { allowed: false, reason: RBAC_REFUSALS.NO_BINDING, required: permission };
    }
    const held = this.permissionsFor(role);
    if (!held.includes(permission)) {
      TelemetryLogger.warn('RBAC refused: role lacks the permission', { metadata: { tenantId: principal.tenantId, role, permission } });
      return { allowed: false, reason: RBAC_REFUSALS.PERMISSION_DENIED, required: permission };
    }

    const binding = BINDINGS.get(principal.credentialId ?? principal.tenantId);
    if (!binding) return { allowed: true, required: permission };

    if (resource === undefined) return { allowed: true, required: permission };
    if (binding.resources.includes(ANY_RESOURCE)) return { allowed: true, required: permission };
    if (binding.resources.includes(resource)) return { allowed: true, required: permission };

    TelemetryLogger.warn('RBAC refused: resource is out of scope', { metadata: { tenantId: principal.tenantId, role, permission, resource } });
    return { allowed: false, reason: RBAC_REFUSALS.RESOURCE_OUT_OF_SCOPE, required: permission };
  }

  public static resetForTests(): void {
    BINDINGS.clear();
  }
}
