/**
 * Niche adapter completion tests.
 *
 * Covers the P1 niche-completion workstream:
 *   - Custom B2B now renders a real compliance verdict against the tenant's declared
 *     control set (customGuardrails), instead of fabricating SOC2 evidence.
 *   - A tenant with no control set is refused, never approximated.
 *   - Financial Services is a new operational vertical with payment/fraud controls:
 *     PCI DSS card-data boundary, AML structuring detection, counterparty sanctions
 *     screening, and high-value-transaction review.
 *
 * Every assertion is about real controls actually evaluated — no `isCompliant: true`
 * for a payload no control has examined.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { NicheAdapterService } from '../src/services/nicheAdapterService';
import { IndustryNiche } from '../src/models/tenant';
import { NICHE_REGISTRY, OPERATIONAL_NICHES } from '../src/configurations/factory.config';
import { validateIncomingTelemetry } from '../src/utils/validation';

function customB2bPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId: 'TX-9911',
    counterparty: 'Acme Industrial Supply',
    amountUsd: 250_000,
    ...overrides,
  };
}

test('custom_b2b with a tenant control set renders a real compliance verdict', () => {
  const { result, error } = NicheAdapterService.processAdapter(
    IndustryNiche.CUSTOM_B2B,
    customB2bPayload({ auditLogEnabled: true, accessReviewed: true, accessControlEnabled: true, privilegeEscalation: false }),
    { customGuardrails: ['SOC2 Trust Service Criteria', 'ISO 27001 Access Boundary'] },
  );

  assert.equal(error, undefined);
  assert.ok(result);
  assert.equal(result!.isCompliant, true);
  assert.ok(result!.guardrailsApplied.includes('SOC2 Trust Service Criteria'));
  assert.ok(result!.guardrailsApplied.includes('ISO 27001 Access Boundary'));
  assert.equal(result!.violationNotice, undefined);
});

test('custom_b2b fails compliance when a declared control is not satisfied', () => {
  const { result } = NicheAdapterService.processAdapter(
    IndustryNiche.CUSTOM_B2B,
    customB2bPayload({ auditLogEnabled: false, accessReviewed: true }),
    { customGuardrails: ['SOC2 Trust Service Criteria'] },
  );

  assert.ok(result);
  assert.equal(result!.isCompliant, false);
  assert.ok(result!.violationNotice!.includes('control not satisfied: SOC2 Trust Service Criteria'));
});

test('custom_b2b with no control set is refused, never approximated', () => {
  const { result, error } = NicheAdapterService.processAdapter(
    IndustryNiche.CUSTOM_B2B,
    customB2bPayload(),
    {},
  );

  assert.equal(result, undefined);
  assert.ok(error);
  assert.equal((error as { code: string }).code, 'NICHE_NOT_SERVED');
  assert.ok(
    (error as { message: string }).message.includes('control set'),
    'the refusal must name the missing control set',
  );
});

test('custom_b2b refuses an undeclared guardrail instead of fabricating a pass', () => {
  const { result } = NicheAdapterService.processAdapter(
    IndustryNiche.CUSTOM_B2B,
    customB2bPayload(),
    { customGuardrails: ['Nonexistent Control'] },
  );

  assert.ok(result);
  assert.equal(result!.isCompliant, false);
  assert.ok(result!.violationNotice!.includes('Nonexistent Control'));
});

test('financial services: raw card data fails PCI DSS boundary', () => {
  const { result } = NicheAdapterService.processAdapter(
    IndustryNiche.FINANCIAL_SERVICES,
    { transactionId: 'TX-1', counterparty: 'Good Co', amountUsd: 500, cardNumber: '4111111111111111' },
  );

  assert.ok(result);
  assert.equal(result!.isCompliant, false);
  assert.ok(result!.guardrailsApplied.includes('PCI DSS Card Data Boundary'));
  assert.ok(result!.normalizedPayload as Record<string, unknown>);
  assert.equal((result!.normalizedPayload as Record<string, unknown>).sanctionedCounterparty, false);
});

test('financial services: sanctioned counterparty fails compliance', () => {
  const { result } = NicheAdapterService.processAdapter(
    IndustryNiche.FINANCIAL_SERVICES,
    { transactionId: 'TX-2', counterparty: 'sanctioned-entity-alpha', amountUsd: 100 },
  );

  assert.ok(result);
  assert.equal(result!.isCompliant, false);
  assert.equal((result!.normalizedPayload as Record<string, unknown>).sanctionedCounterparty, true);
  assert.ok(result!.violationNotice!.includes('sanctions list'));
});

test('financial services: structuring just under threshold fails AML', () => {
  const { result } = NicheAdapterService.processAdapter(
    IndustryNiche.FINANCIAL_SERVICES,
    { transactionId: 'TX-3', counterparty: 'Good Co', amountUsd: 9_500 },
  );

  assert.ok(result);
  assert.equal(result!.isCompliant, false);
  assert.ok(result!.violationNotice!.includes('structuring'));
});

test('financial services: over-threshold transaction requires review but can still comply', () => {
  const { result } = NicheAdapterService.processAdapter(
    IndustryNiche.FINANCIAL_SERVICES,
    { transactionId: 'TX-4', counterparty: 'Good Co', amountUsd: 15_000 },
  );

  assert.ok(result);
  assert.equal(result!.isCompliant, true); // no critical violation, just review required
  assert.equal((result!.normalizedPayload as Record<string, unknown>).reviewRequired, true);
  assert.ok(result!.violationNotice!.includes('exceeds review threshold'));
});

test('financial services: clean transaction complies', () => {
  const { result } = NicheAdapterService.processAdapter(
    IndustryNiche.FINANCIAL_SERVICES,
    { transactionId: 'TX-5', counterparty: 'Good Co', amountUsd: 750 },
  );

  assert.ok(result);
  assert.equal(result!.isCompliant, true);
  assert.equal(result!.violationNotice, undefined);
});

test('the three originally served niches are unaffected by custom_b2b and financial_services', () => {
  const served: [IndustryNiche, Record<string, unknown>][] = [
    [IndustryNiche.REAL_ESTATE, { propertyType: 'Condo', squareFootage: 1200, listPrice: 500_000 }],
    [IndustryNiche.HEALTHCARE, { patientName: 'J. Doe', vitals: { hr: 80 } }],
    [IndustryNiche.LOGISTICS, { cargoTemperatureCelsius: 4, minAllowedTempCelsius: 2, maxAllowedTempCelsius: 8 }],
    [IndustryNiche.FINANCIAL_SERVICES, { transactionId: 'TX-6', counterparty: 'Good Co', amountUsd: 750 }],
  ];

  for (const [niche, payload] of served) {
    const { result, error } = NicheAdapterService.processAdapter(niche, payload);
    assert.equal(error, undefined, `${niche} must not be refused`);
    assert.ok(result, `${niche} must return a result`);
    assert.equal(result!.isCompliant, true, `${niche} compliant input must be served`);
    assert.ok(result!.guardrailsApplied.length > 0, `${niche} must report guardrails applied`);
  }
});

test('the registry marks custom_b2b and financial_services as operational', () => {
  assert.equal(NICHE_REGISTRY[IndustryNiche.CUSTOM_B2B].operational, true);
  assert.equal(NICHE_REGISTRY[IndustryNiche.FINANCIAL_SERVICES].operational, true);
  assert.equal(NICHE_REGISTRY[IndustryNiche.CUSTOM_B2B].unavailableReason, undefined);
  assert.equal(
    OPERATIONAL_NICHES.includes(IndustryNiche.CUSTOM_B2B),
    true,
    'custom_b2b must be listed as operational',
  );
  assert.equal(
    OPERATIONAL_NICHES.includes(IndustryNiche.FINANCIAL_SERVICES),
    true,
    'financial_services must be listed as operational',
  );
});

test('validation: financial_services requires transactionId, counterparty, amountUsd', () => {
  const valid = validateIncomingTelemetry({
    tenantId: 't1',
    niche: IndustryNiche.FINANCIAL_SERVICES,
    eventType: 'PAYMENT_INITIATED',
    metadata: { idempotencyKey: 'idem-1' },
    payload: { transactionId: 'TX-1', counterparty: 'Good Co', amountUsd: 500 },
  });
  assert.equal(valid.isValid, true);

  const missingId = validateIncomingTelemetry({
    tenantId: 't1',
    niche: IndustryNiche.FINANCIAL_SERVICES,
    eventType: 'PAYMENT_INITIATED',
    metadata: { idempotencyKey: 'idem-2' },
    payload: { counterparty: 'Good Co', amountUsd: 500 },
  });
  assert.equal(missingId.isValid, false);
  assert.ok(missingId.error!.message.includes('transactionId'));

  const missingAmount = validateIncomingTelemetry({
    tenantId: 't1',
    niche: IndustryNiche.FINANCIAL_SERVICES,
    eventType: 'PAYMENT_INITIATED',
    metadata: { idempotencyKey: 'idem-3' },
    payload: { transactionId: 'TX-1', counterparty: 'Good Co' },
  });
  assert.equal(missingAmount.isValid, false);
  assert.ok(missingAmount.error!.message.includes('amountUsd'));
});
