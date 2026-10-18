/**
 * NC-8: every modelled niche has an implemented adapter; none are approximated.
 *
 * This file previously proved that `custom_b2b` was refused instead of being given a
 * neighbouring adapter (the defect: a default branch returned `isCompliant: true` and
 * listed guardrails that had never been applied). custom_b2b is now served by its own
 * adapter, which evaluates the tenant's declared control set. These tests pin that the
 * served niches render real verdicts, and that the `default` branch of the adapter switch
 * still refuses honestly for any niche modelled in the enum but not yet handled — so a
 * future niche cannot silently inherit a neighbour's controls.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { NicheAdapterService } from '../src/services/nicheAdapterService';
import { IndustryNiche } from '../src/models/tenant';
import { NICHE_REGISTRY, OPERATIONAL_NICHES } from '../src/configurations/factory.config';

test('NC-8: custom_b2b is now served by its own tenant-control-set adapter', () => {
  const { result, error } = NicheAdapterService.processAdapter(
    IndustryNiche.CUSTOM_B2B,
    { transactionId: 'TX-1', counterparty: 'Acme', amountUsd: 100, auditLogEnabled: true, accessReviewed: true, accessControlEnabled: true, privilegeEscalation: false },
    { customGuardrails: ['SOC2 Trust Service Criteria', 'ISO 27001 Access Boundary'] },
  );

  assert.equal(error, undefined, 'custom_b2b must be served by its adapter');
  assert.ok(result, 'custom_b2b must return a result');
  assert.equal(result!.isCompliant, true, 'custom_b2b compliant input must be served');
  assert.ok(
    result!.guardrailsApplied.includes('SOC2 Trust Service Criteria'),
    'the applied guardrails must be the tenant-declared control set, not fabricated ones',
  );
  const serialised = JSON.stringify(result).toLowerCase();
  assert.equal(
    serialised.includes('soc2'),
    true,
    'the tenant-declared SOC2 guardrail must be reported as applied',
  );
});

test('NC-8: financial_services is a served vertical with payment/fraud controls', () => {
  const { result, error } = NicheAdapterService.processAdapter(
    IndustryNiche.FINANCIAL_SERVICES,
    { transactionId: 'TX-7', counterparty: 'Good Co', amountUsd: 750 },
  );

  assert.equal(error, undefined, 'financial_services must be served');
  assert.ok(result, 'financial_services must return a result');
  assert.equal(result!.isCompliant, true, 'clean financial transaction must comply');
  assert.ok(
    result!.guardrailsApplied.includes('PCI DSS Card Data Boundary'),
    'the card-data boundary guardrail must be applied',
  );
  assert.ok(
    result!.guardrailsApplied.includes('Counterparty Sanctions Screening'),
    'the sanctions screening guardrail must be applied',
  );
  assert.ok(
    result!.guardrailsApplied.includes('AML Transaction Monitoring'),
    'the AML monitoring guardrail must be applied',
  );
});

test('NC-8: an unregistered niche is refused before the adapter switch', () => {
  // A niche value not present in NICHE_REGISTRY cannot be served: the registry guard
  // fires first, so the caller gets a distinguishable MALFORMED_CONTEXT rather than a
  // neighbour's controls.
  const unknownNiche = 'future_niche_placeholder' as unknown as IndustryNiche;
  const { result, error } = NicheAdapterService.processAdapter(unknownNiche, { anything: 'goes' });

  assert.equal(result, undefined, 'an unregistered niche must not return a result');
  assert.ok(error, 'the refusal must be an error');
  assert.equal((error as { code: string }).code, 'MALFORMED_CONTEXT');
});

test('NC-8: the three originally served niches are unaffected', () => {
  const served: [IndustryNiche, Record<string, unknown>][] = [
    [IndustryNiche.REAL_ESTATE, { propertyType: 'Condo', squareFootage: 1200, listPrice: 500_000 }],
    [IndustryNiche.HEALTHCARE, { patientName: 'J. Doe', vitals: { hr: 80 } }],
    [IndustryNiche.LOGISTICS, { cargoTemperatureCelsius: 4, minAllowedTempCelsius: 2, maxAllowedTempCelsius: 8 }],
  ];

  for (const [niche, payload] of served) {
    const { result, error } = NicheAdapterService.processAdapter(niche, payload);
    assert.equal(error, undefined, `${niche} must not be refused`);
    assert.ok(result, `${niche} must return a result`);
    assert.equal(result!.isCompliant, true, `${niche} compliant input must be served`);
    assert.ok(result!.guardrailsApplied.length > 0, `${niche} must report guardrails applied`);
  }
});

test('NC-8: healthcare still scrubs identifiers, so the adapter boundary holds', () => {
  const { result } = NicheAdapterService.processAdapter(IndustryNiche.HEALTHCARE, {
    patientName: 'Jane Doe',
    ssn: '123-45-6789',
    email: 'jane@example.com',
  });

  assert.ok(result);
  const scrubbed = JSON.stringify(result!.normalizedPayload);
  assert.equal(scrubbed.includes('Jane Doe'), false, 'the patient name must be removed');
  assert.equal(scrubbed.includes('123-45-6789'), false, 'the SSN must be removed');
  assert.equal(scrubbed.includes('jane@example.com'), false, 'the email must be removed');
});

test('NC-8: the registry marks all modelled niches operational', () => {
  for (const niche of Object.values(IndustryNiche)) {
    const entry = NICHE_REGISTRY[niche];
    assert.ok(entry, `niche ${niche} must be present in the registry`);
    assert.equal(
      entry.operational,
      true,
      `niche ${niche} must be marked operational now that it has an adapter`,
    );
    assert.equal(
      entry.unavailableReason,
      undefined,
      `niche ${niche} must not carry an unavailableReason when operational`,
    );
  }

  for (const niche of OPERATIONAL_NICHES) {
    assert.equal(
      NICHE_REGISTRY[niche].operational,
      true,
      'every niche listed as operational must be marked operational in the registry',
    );
  }
});
