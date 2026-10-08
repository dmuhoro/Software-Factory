/**
 * Sprint 25, phase 7: resource-scoped RBAC.
 *
 * The rule under test is the chain: principal → role → permission → resource. Both
 * halves must pass. A credential scoped to a write held by an auditor still cannot
 * start a run, and an operator bound to one repository cannot touch another.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ANY_RESOURCE, PERMISSIONS, RBAC_REFUSALS, ROLES, RbacService, type Permission, type Role } from '../src/services/rbacService';
import type { AuthenticatedPrincipal } from '../src/api/middleware/tenantAuth';
import { classifyApiError } from '../src/utils/apiError';

function principal(overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return { tenantId: 'tenant_scoped_0001', role: 'tenant_operator', scopes: ['admin'], kind: 'root', ...overrides };
}

test('the role and permission sets are closed, and each role holds strictly less than admin', () => {
  assert.deepEqual([...ROLES], ['admin', 'operator', 'auditor', 'viewer']);
  assert.deepEqual([...PERMISSIONS], ['loop:read', 'loop:submit', 'loop:cancel', 'credential:provision', 'webhook:manage', 'audit:read']);

  const admin = RbacService.permissionsFor('admin');
  for (const role of ROLES) {
    const held = RbacService.permissionsFor(role);
    for (const permission of held) {
      assert.ok(admin.includes(permission), `${role} holds ${permission} which admin does not`);
    }
  }
  assert.ok(RbacService.permissionsFor('operator').includes('loop:cancel'));
  assert.ok(!RbacService.permissionsFor('operator').includes('credential:provision'), 'an operator must not mint credentials');
  assert.deepEqual(RbacService.permissionsFor('auditor'), ['loop:read', 'audit:read'], 'an auditor is read-only');
  assert.deepEqual(RbacService.permissionsFor('viewer'), ['loop:read']);
});

test('an unrecognised role is no role, and no role is no permission', () => {
  // A typo in a role name must not silently grant access.
  for (const bad of ['Admin', 'superuser', 'root', '', null, undefined, 42, ['admin']]) {
    assert.deepEqual(RbacService.permissionsFor(bad), [], `${JSON.stringify(bad)} must grant nothing`);
  }
});

test('a binding must name a resource, and an empty list is refused rather than meaning everything', () => {
  RbacService.resetForTests();
  assert.throws(() => RbacService.bind('p1', 'operator', []), /at least one resource/);
  assert.throws(() => RbacService.bind('p1', 'not-a-role' as Role, ['repo']), /not one of/);

  // The wildcard is explicit, not a fallback an empty list quietly becomes.
  const wildcard = RbacService.bind('p1', 'admin', [ANY_RESOURCE]);
  assert.deepEqual(wildcard.resources, ['*']);
});

test('a principal whose kind cannot be interpreted holds no role, and is refused', () => {
  // The middleware only ever produces `root` or `scoped`, so this is defensive. It is
  // here because a refusal reason that could never fire would be a claim of protection
  // this code does not provide.
  RbacService.resetForTests();
  const decision = RbacService.check(principal({ kind: undefined as unknown as 'root' }), 'loop:read');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, RBAC_REFUSALS.NO_BINDING);
  assert.equal(decision.required, 'loop:read');

  // A principal with an explicit binding is unaffected by the kind being uninterpretable:
  // the binding is what names the role.
  RbacService.bind('sfc_bound', 'auditor', [ANY_RESOURCE]);
  assert.equal(RbacService.check(principal({ kind: undefined as unknown as 'root', credentialId: 'sfc_bound' }), 'loop:read').allowed, true);
});

test('the root credential is an admin and a scoped one is a viewer, without an explicit binding', () => {
  RbacService.resetForTests();
  assert.equal(RbacService.roleFor(principal({ kind: 'root' })), 'admin');
  assert.equal(RbacService.roleFor(principal({ kind: 'scoped', credentialId: 'sfc_x' })), 'viewer');

  // Which means a scoped credential cannot escalate by being scoped to admin.
  const scoped = principal({ kind: 'scoped', credentialId: 'sfc_x', scopes: ['admin'] });
  assert.equal(RbacService.check(scoped, 'loop:cancel').allowed, false, 'a scoped credential is a viewer regardless of its scope');
});

test('a role cannot exceed its permission set, however the credential is scoped', () => {
  RbacService.resetForTests();
  RbacService.bind('sfc_auditor', 'auditor', [ANY_RESOURCE]);
  const auditor = principal({ kind: 'scoped', credentialId: 'sfc_auditor', scopes: ['admin'] });

  assert.equal(RbacService.check(auditor, 'loop:read').allowed, true, 'an auditor may read');
  assert.equal(RbacService.check(auditor, 'audit:read').allowed, true, 'and may read the audit trail');
  const cancel = RbacService.check(auditor, 'loop:cancel');
  assert.equal(cancel.allowed, false, 'an auditor must not cancel a run, however the credential is scoped');
  assert.equal(cancel.reason, RBAC_REFUSALS.PERMISSION_DENIED);
  assert.equal(cancel.required, 'loop:cancel');
});

test('a binding that names a resource does not reach another one', () => {
  RbacService.resetForTests();
  RbacService.bind('sfc_operator', 'operator', ['repo/staging']);
  const operator = principal({ kind: 'scoped', credentialId: 'sfc_operator' });

  assert.equal(RbacService.check(operator, 'loop:cancel', 'repo/staging').allowed, true, 'in scope');
  const outside = RbacService.check(operator, 'loop:cancel', 'repo/production');
  assert.equal(outside.allowed, false, 'out of scope');
  assert.equal(outside.reason, RBAC_REFUSALS.RESOURCE_OUT_OF_SCOPE);

  // With no resource named, the permission alone decides: an operator may cancel
  // somewhere, so an unscoped check passes and the resource check is left to the route.
  assert.equal(RbacService.check(operator, 'loop:cancel').allowed, true);
});

test('the wildcard reaches everything, and only an explicit wildcard does', () => {
  RbacService.resetForTests();
  RbacService.bind('sfc_admin', 'admin', [ANY_RESOURCE]);
  const admin = principal({ kind: 'root', credentialId: 'sfc_admin' });
  for (const resource of ['repo/staging', 'repo/production', 'repo/anything']) {
    assert.equal(RbacService.check(admin, 'loop:cancel', resource).allowed, true, `${resource} must be in scope`);
  }

  RbacService.resetForTests();
  RbacService.bind('sfc_named', 'admin', ['repo/staging']);
  const named = principal({ kind: 'root', credentialId: 'sfc_named' });
  assert.equal(RbacService.check(named, 'loop:cancel', 'repo/production').allowed, false, 'an admin bound to one resource is still bound');
});

test('an unknown permission is refused rather than treated as a new one', () => {
  RbacService.resetForTests();
  RbacService.bind('sfc_admin', 'admin', [ANY_RESOURCE]);
  const decision = RbacService.check(principal({ credentialId: 'sfc_admin' }), 'loop:delete' as Permission);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, RBAC_REFUSALS.PERMISSION_DENIED);
});

test('every RBAC refusal classifies as a domain condition, not an internal fault', () => {
  for (const reason of Object.values(RBAC_REFUSALS)) {
    const classified = classifyApiError(new Error(reason));
    assert.notEqual(classified.status, 500, `${reason} must not be reported as a server fault`);
  }
});

test('unbinding reverts to the credential kind default, and drops the resource scope with it', () => {
  // Unbinding does not mean "no access"; it means the explicit override is gone and the
  // default for the credential kind applies again. A root credential is an admin by
  // being the root, not by being bound.
  RbacService.resetForTests();
  RbacService.bind('sfc_operator', 'operator', ['repo/staging']);
  const bound = principal({ credentialId: 'sfc_operator' });
  assert.equal(RbacService.roleFor(bound), 'operator');
  assert.equal(RbacService.check(bound, 'loop:cancel', 'repo/production').allowed, false, 'while bound, out of scope');

  RbacService.unbind('sfc_operator');
  assert.equal(RbacService.binding('sfc_operator'), undefined);
  const unbound = principal({ credentialId: 'sfc_operator' });
  assert.equal(RbacService.roleFor(unbound), 'admin', 'the root credential default returns');
  assert.equal(RbacService.check(unbound, 'loop:cancel', 'repo/production').allowed, true, 'and the resource limit went with the binding');
});
