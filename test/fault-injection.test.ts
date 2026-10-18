/**
 * Fault Injection & Hostile Repository Tests (P2).
 *
 * Exercises inputs the product must refuse without needing live model keys:
 *   - Telemetry validation rejects PHI, missing fields, and wrong-shaped payloads.
 *   - Niche adapters refuse hostile or incomplete payloads; never fabricate compliance.
 *   - RBAC refuses resource-out-of-scope access.
 *   - Path guard defeats symlink escapes into / outside the repository.
 *
 * Every test asserts a refusal or a real, evaluated verdict — never a fabricated pass.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateIncomingTelemetry } from '../src/utils/validation';
import { IndustryNiche } from '../src/models/tenant';
import { NicheAdapterService } from '../src/services/nicheAdapterService';
import { RbacService, ANY_RESOURCE, RBAC_REFUSALS } from '../src/services/rbacService';
import { resolveFileWithin } from '../src/utils/pathGuard';
import type { Scope } from '../src/utils/scopedCredentials';
import type { AuthenticatedPrincipal } from '../src/api/middleware/tenantAuth';

function principal(kind: AuthenticatedPrincipal['kind'] = 'root', credentialId?: string): AuthenticatedPrincipal {
  return { tenantId: 'tenant-fault-injection', role: 'tenant_operator', scopes: [] as Scope[], kind, credentialId };
}

// ── Telemetry validation: hostile payloads are refused ────

test('validation: healthcare payload with direct PHI (SSN) is refused', () => {
  const result = validateIncomingTelemetry({
    tenantId: 't1',
    niche: IndustryNiche.HEALTHCARE,
    eventType: 'PATIENT_INTAKE',
    metadata: { idempotencyKey: 'idem-phi' },
    payload: { patientCohortId: 'C-1', patientFullName: 'Jane Doe', ssn: '123-45-6789' },
  });
  assert.equal(result.isValid, false);
  assert.ok(result.error!.message.includes('PHI'), 'direct PHI must be named');
});

test('validation: healthcare payload with email is refused', () => {
  const result = validateIncomingTelemetry({
    tenantId: 't1',
    niche: IndustryNiche.HEALTHCARE,
    eventType: 'PATIENT_INTAKE',
    metadata: { idempotencyKey: 'idem-email' },
    payload: { patientCohortId: 'C-1', email: 'jane@example.com' },
  });
  assert.equal(result.isValid, false);
  assert.ok(result.error!.message.includes('PHI'), 'email is direct PHI');
});

test('validation: financial services missing amountUsd is refused', () => {
  const result = validateIncomingTelemetry({
    tenantId: 't1',
    niche: IndustryNiche.FINANCIAL_SERVICES,
    eventType: 'PAYMENT_INITIATED',
    metadata: { idempotencyKey: 'idem-noamt' },
    payload: { transactionId: 'TX-1', counterparty: 'Good Co' },
  });
  assert.equal(result.isValid, false);
  assert.ok(result.error!.message.includes('amountUsd'));
});

test('validation: unknown niche is refused', () => {
  const result = validateIncomingTelemetry({
    tenantId: 't1',
    niche: 'not_a_real_niche' as IndustryNiche,
    eventType: 'ANYTHING',
    metadata: { idempotencyKey: 'idem-bad' },
    payload: {},
  });
  assert.equal(result.isValid, false);
  assert.ok(result.error!.message.includes('niche'));
});

test('validation: missing idempotency key is refused (ADR-001 composite key)', () => {
  const result = validateIncomingTelemetry({
    tenantId: 't1',
    niche: IndustryNiche.REAL_ESTATE,
    eventType: 'PROPERTY_LISTED',
    metadata: {},
    payload: { propertyId: 'P-1' },
  });
  assert.equal(result.isValid, false);
  assert.ok(result.error!.message.includes('idempotencyKey'));
});

// ── Niche adapters: hostile payloads never fabricate compliance ────

test('niche: healthcare adapter scrubs PHI from normalized output', () => {
  const { result } = NicheAdapterService.processAdapter(IndustryNiche.HEALTHCARE, {
    patientCohortId: 'C-1',
    patientName: 'Jane Doe',
    ssn: '123-45-6789',
    address: '123 Main St',
    phoneNumber: '555-0100',
    email: 'jane@example.com',
  });
  assert.ok(result);
  const scrubbed = JSON.stringify(result!.normalizedPayload);
  for (const phi of ['Jane Doe', '123-45-6789', '123 Main St', '555-0100', 'jane@example.com']) {
    assert.equal(scrubbed.includes(phi), false, `PHI must not appear: ${phi}`);
  }
  assert.equal(result!.isCompliant, true);
});

test('niche: logistics thermal excursion is a real violation, not a pass', () => {
  const { result } = NicheAdapterService.processAdapter(IndustryNiche.LOGISTICS, {
    cargoTemperatureCelsius: 15,
    minAllowedTempCelsius: 2,
    maxAllowedTempCelsius: 8,
  });
  assert.ok(result);
  assert.equal(result!.isCompliant, false);
  assert.ok(result!.normalizedPayload as Record<string, unknown>);
  assert.equal((result!.normalizedPayload as Record<string, unknown>).excursionDetected, true);
  assert.ok(result!.violationNotice!.includes('Thermal excursion'));
});

test('niche: custom_b2b with an unevaluable guardrail fails closed', () => {
  const { result } = NicheAdapterService.processAdapter(
    IndustryNiche.CUSTOM_B2B,
    { transactionId: 'TX-1', counterparty: 'Acme', amountUsd: 100, auditLogEnabled: true, accessReviewed: true },
    { customGuardrails: ['SOC2 Trust Service Criteria', 'Made-Up Control'] },
  );
  assert.ok(result);
  assert.equal(result!.isCompliant, false, 'an unevaluable guardrail must fail closed');
});

// ── RBAC: resource out of scope is refused ────

test('rbac: scoped credential cannot reach a resource outside its binding', () => {
  RbacService.resetForTests();
  RbacService.bind('scoped-cred-1', 'operator', ['repo-a']);
  const scoped = principal('scoped', 'scoped-cred-1');
  const decision = RbacService.check(scoped, 'loop:submit', 'repo-b');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, RBAC_REFUSALS.RESOURCE_OUT_OF_SCOPE);
});

test('rbac: wildcard binding reaches every resource', () => {
  RbacService.resetForTests();
  RbacService.bind('admin-cred-1', 'admin', [ANY_RESOURCE]);
  const admin = principal('root', 'admin-cred-1');
  const decision = RbacService.check(admin, 'loop:cancel', 'any-repo-at-all');
  assert.equal(decision.allowed, true);
});

// ── Path guard: symlink escapes are defeated ────

function makeSymlinkRepo(targetOutside: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fault-injection-repo-'));
  fs.writeFileSync(path.join(repo, 'inside.txt'), 'inside content');
  fs.writeFileSync(targetOutside, 'outside secret');
  fs.symlinkSync(targetOutside, path.join(repo, 'link-outside.txt'));
  return repo;
}

test('path guard: symlink pointing outside the repo is refused', () => {
  const outside = path.join(os.tmpdir(), 'fault-injection-secret.txt');
  const repo = makeSymlinkRepo(outside);
  assert.throws(
    () => resolveFileWithin(repo, 'link-outside.txt'),
    /FILE_OUTSIDE_REPOSITORY/,
    'a symlink to outside the repo must be refused',
  );
  fs.rmSync(outside, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('path guard: in-repo file and new file resolve normally', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fault-injection-repo-'));
  fs.writeFileSync(path.join(repo, 'inside.txt'), 'inside content');
  const inRepo = resolveFileWithin(repo, 'inside.txt');
  assert.equal(inRepo, path.join(repo, 'inside.txt'));
  const newFile = resolveFileWithin(repo, 'newfile.txt');
  assert.equal(newFile, path.join(repo, 'newfile.txt'));
  fs.rmSync(repo, { recursive: true, force: true });
});

test('path guard: path traversal (..) is refused', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fault-injection-repo-'));
  fs.writeFileSync(path.join(repo, 'inside.txt'), 'x');
  assert.throws(
    () => resolveFileWithin(repo, '../../etc/passwd'),
    /FILE_OUTSIDE_REPOSITORY/,
    'traversal must be refused',
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

test('path guard: symlink in a subdirectory pointing outside is refused', () => {
  const outside = path.join(os.tmpdir(), 'fault-injection-subdir-secret.txt');
  fs.writeFileSync(outside, 'outside secret');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fault-injection-repo-'));
  fs.mkdirSync(path.join(repo, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'subdir', 'inside.txt'), 'inside content');
  fs.symlinkSync(outside, path.join(repo, 'subdir', 'link-outside.txt'));
  assert.throws(
    () => resolveFileWithin(repo, 'subdir/link-outside.txt'),
    /FILE_OUTSIDE_REPOSITORY/,
    'a symlink in a subdirectory pointing outside must be refused',
  );
  fs.rmSync(outside, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('path guard: .git/hooks path is refused', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fault-injection-repo-'));
  fs.writeFileSync(path.join(repo, 'inside.txt'), 'x');
  assert.throws(
    () => resolveFileWithin(repo, '.git/hooks/pre-commit'),
    /FILE_OUTSIDE_REPOSITORY|TOOL_APPLY_PATH_GITDIR/,
    'a .git/hooks path must be refused',
  );
  fs.rmSync(repo, { recursive: true, force: true });
});
