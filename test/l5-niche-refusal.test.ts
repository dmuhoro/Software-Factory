/**
 * NC-8: a niche with no implemented adapter must be refused, not approximated.
 *
 * This is a test of a refusal, which is easy to write in a way that proves nothing. The
 * specific way this defect appeared was a service that answered every `custom_b2b` request
 * with `isCompliant: true` and a list of guardrails it had not run. A test that only checks
 * "an error was returned" would pass against any error, including a timeout or a typo, so
 * these tests pin the specific refusal, and then assert the thing that actually matters:
 * that no compliance verdict and no guardrail claim is returned for an unserved niche.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { NicheAdapterService } from '../src/services/nicheAdapterService';
import { IndustryNiche } from '../src/models/tenant';
import { NICHE_REGISTRY, OPERATIONAL_NICHES } from '../src/configurations/factory.config';
import { classifyApiError } from '../src/utils/apiError';

const UNSERVED = IndustryNiche.CUSTOM_B2B;

test('NC-8: an unserved niche is refused instead of being given a neighbouring adapter', () => {
  const { result, error } = NicheAdapterService.processAdapter(UNSERVED, {
    transactionId: 'TX-9911',
    counterparty: 'Acme Industrial Supply',
    amountUsd: 250_000,
  });

  assert.equal(
    result,
    undefined,
    'an unserved niche must not return a result. A result here is the whole defect: the ' +
      'previous implementation returned one with isCompliant: true for a payload no control ' +
      'had ever examined.',
  );
  assert.ok(error, 'the refusal must be an error, not a silent success');
  assert.equal(
    (error as { code: string }).code,
    'NICHE_NOT_SERVED',
    'the refusal must be distinguishable from a malformed payload, because the operator ' +
      'action is different: one is fixed in the caller, the other by providing an adapter',
  );
});

test('NC-8: the refusal never asserts a compliance verdict or a guardrail claim', () => {
  // The precise harm was a manufactured audit artefact. A tenant integrating against this
  // would have held SOC2 evidence in its own records that this service invented, and the
  // only trace of the absence of any real check was a list of guardrails with nothing behind
  // them. So the assertion is about the CONTENT, not merely the presence of an error.
  const { result } = NicheAdapterService.processAdapter(UNSERVED, { anything: 'goes' });

  assert.equal(result, undefined);
  const serialised = JSON.stringify(result ?? null).toLowerCase();
  for (const fabrication of ['iscompliant', 'guardrailsapplied', 'soc2', 'compliant']) {
    assert.equal(
      serialised.includes(fabrication),
      false,
      `the refusal leaked a compliance claim containing "${fabrication}": ${serialised}`,
    );
  }
});

test('NC-8: the three served niches are unaffected by the refusal', () => {
  // A refusal added for a missing adapter must not become a refusal for everything. These
  // three are the product, and this asserts they still work after the change.
  const served: [IndustryNiche, Record<string, unknown>][] = [
    [IndustryNiche.REAL_ESTATE, { propertyType: 'Condo', squareFootage: 1200, listPrice: 500_000 }],
    [IndustryNiche.HEALTHCARE, { patientName: 'J. Doe', vitals: { hr: 80 } }],
    [IndustryNiche.LOGISTICS, { cargoTemperatureCelsius: 4, minAllowedTempCelsius: 2, maxAllowedTempCelsius: 8 }],
  ];

  for (const [niche, payload] of served) {
    const { result, error } = NicheAdapterService.processAdapter(niche, payload);
    assert.equal(error, undefined, `${niche} must not be refused: it has an implemented adapter`);
    assert.ok(result, `${niche} must return a result`);
    assert.equal(result!.isCompliant, true, `${niche} is compliant input and must be served`);
    assert.ok(
      result!.guardrailsApplied.length > 0,
      `${niche} must report the guardrails it actually applied`,
    );
  }
});

test('NC-8: healthcare still scrubs identifiers, so the refusal did not bypass the boundary', () => {
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

test('NC-8: the registry marks custom_b2b as present but not operational', () => {
  // The gap stays listed. Hiding a niche would make the platform look more capable than it
  // is; the flag is what makes the difference between "works" and "answers plausibly"
  // legible to an operator or an integrator reading the API.
  const custom = NICHE_REGISTRY[UNSERVED];
  assert.ok(custom, 'custom_b2b must remain in the registry so the gap is visible');
  assert.equal(custom.operational, false);
  assert.ok(
    custom.unavailableReason && custom.unavailableReason.length > 20,
    'an unserved niche must explain itself, or an operator cannot tell the gap from a bug',
  );

  // And it must not be advertised as served.
  assert.equal(OPERATIONAL_NICHES.includes(UNSERVED), false);
  for (const niche of OPERATIONAL_NICHES) {
    assert.equal(
      NICHE_REGISTRY[niche].operational,
      true,
      'every niche listed as operational must be marked operational in the registry',
    );
  }
});

test('NC-8: NICHE_NOT_SERVED resolves to a vetted public status and message', () => {
  // The public message is fixed. It must not echo the payload, and it must not enumerate the
  // served niches, which would be an invitation to probe the boundary one guess at a time.
  const classified = classifyApiError(new Error('NICHE_NOT_SERVED: some_tenant_payload'));
  assert.equal(classified.code, 'NICHE_NOT_SERVED');
  assert.equal(classified.status, 403);
  assert.equal(
    classified.message.includes('some_tenant_payload'),
    false,
    'the published message must not echo caller data',
  );
  for (const served of ['real_estate', 'healthcare', 'logistics']) {
    assert.equal(
      classified.message.includes(served),
      false,
      `the published message must not enumerate served niches; it leaked "${served}"`,
    );
  }
});
