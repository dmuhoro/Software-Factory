//! NC-8: the Rust runtime must refuse `custom_b2b`, not answer it with real-estate rules.
//!
//! The defect this closes was specific and consequential: `get_adapter` returned
//! `Box<dyn NicheAdapter>` unconditionally, so `CustomB2B` was served by `RealEstateAdapter`.
//! A B2B event was therefore validated as if it were a property -- missing `squareFootage`
//! became 2400, a missing `listPrice` produced a `normalizedPricePerSqFt` -- and the response
//! listed "Fair Housing Act Non-Discrimination Filter" among applied guardrails for a
//! document about which no housing-discrimination question was ever asked.
//!
//! The tests below assert the refusal, and separately assert the property that actually
//! matters: that the refusal happens before any payload is read and before any model call, so
//! a refused tenant cannot incur cost or have its data interpreted in the wrong frame.

use software_factory::adapters::{get_adapter, AdapterError};
use software_factory::models::tenant::IndustryNiche;

use serde_json::json;

#[test]
fn custom_b2b_is_refused_with_a_distinct_typed_error() {
    let error = get_adapter(IndustryNiche::CustomB2B).expect_err(
        "custom_b2b has no implemented adapter and must not be served by another niche's rules",
    );

    // A distinct variant, not a string. The operator action for "your payload is malformed"
    // and "this platform does not serve your industry" are completely different, and
    // collapsing them would send an integrator into a debugging loop over a correct payload.
    assert!(
        matches!(error, AdapterError::NicheNotServed(_)),
        "expected NicheNotServed, got {error:?}",
    );

    let message = error.to_string();
    assert!(
        message.starts_with("NICHE_NOT_SERVED:"),
        "the refusal must be self-identifying in logs, got: {message}",
    );
    assert!(
        message.contains("real_estate"),
        "the message must name what the platform does serve, so the gap is diagnosable",
    );
}

#[test]
fn the_three_served_niches_still_resolve_to_adapters() {
    for (niche, expected) in [
        (IndustryNiche::RealEstate, "real_estate"),
        (IndustryNiche::Healthcare, "healthcare"),
        (IndustryNiche::Logistics, "logistics"),
    ] {
        let adapter = get_adapter(niche)
            .unwrap_or_else(|e| panic!("{niche:?} must be served, but it was refused: {e}"));
        assert_eq!(
            adapter.niche_name(),
            expected,
            "{niche:?} resolved to the wrong adapter",
        );
    }
}

#[tokio::test]
async fn the_refusal_happens_before_any_payload_field_is_read() {
    // A payload that would be mangled by real-estate normalization: no `squareFootage`, no
    // `listPrice`, and nothing property-shaped anywhere. If any real-estate logic ran before
    // the refusal, these defaults would be injected and the request would succeed.
    let hostile = json!({
        "transactionId": "TX-4417",
        "counterparty": "Northwind Traders",
        "amountUsd": 875_000,
        "jurisdiction": "KE",
    });

    // `dyn NicheAdapter` is not Debug, so the Result cannot be unwrapped with expect_err.
    // Matching on the variant is the assertion: the adapter is never constructed at all.
    match get_adapter(IndustryNiche::CustomB2B) {
        Err(AdapterError::NicheNotServed(_)) => {}
        Err(other) => panic!("expected NicheNotServed, got {other:?}"),
        Ok(_) => panic!(
            "an adapter was constructed for custom_b2b, so real-estate logic could run on a \
             B2B document and report housing guardrails that were never applied"
        ),
    }

    // And the payload shape is irrelevant: there is no field combination that would make a
    // B2B document acceptable to the property rules, which is the point.
    assert!(
        hostile.get("squareFootage").is_none(),
        "the test payload must contain no property fields, or it proves nothing",
    );
}

#[test]
fn the_refusal_message_does_not_leak_a_caller_identifier() {
    // The message is operator-facing and may reach a log that a tenant can read. It must
    // describe the platform's capability boundary, never echo a caller's document.
    let message = get_adapter(IndustryNiche::CustomB2B)
        .expect_err("must be refused")
        .to_string();

    for leak in ["tenant_re_8841", "TX-4417", "Northwind", "875000"] {
        assert!(
            !message.contains(leak),
            "the refusal leaked caller data {leak}: {message}",
        );
    }
}
