pub mod healthcare;
pub mod logistics;
pub mod real_estate;

use async_trait::async_trait;
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("Malformed context: {0}")]
    MalformedContext(String),
    #[error("Regulatory compliance violation: {0}")]
    ComplianceViolation(String),
    /// A niche that is modelled but has no implemented, correct adapter.
    ///
    /// This is deliberately its own variant rather than a string in `MalformedContext`. A
    /// caller must be able to distinguish "your payload is wrong" from "this platform does
    /// not serve your industry yet", because the operator action is completely different:
    /// fix the request, or wait for the adapter. Collapsing them into one message would send
    /// an integrator into a debugging loop over a payload that is in fact fine.
    #[error("NICHE_NOT_SERVED: {0}")]
    NicheNotServed(String),
}

/// Swappable Domain Niche Adapter Trait
/// Every industry vertical provides a deterministic implementation of normalization and guardrails.
///
/// `Debug` is required so that a `Result<Box<dyn NicheAdapter>, _>` can be asserted on in
/// tests and logged on error paths. Without it, `expect_err` does not compile for a caller
/// holding a successful adapter, which pushes every such caller into `unwrap`-shaped code --
/// and a refusal is precisely the branch that must be handled, not the one that is dropped.
#[async_trait]
pub trait NicheAdapter: Send + Sync + std::fmt::Debug {
    fn niche_name(&self) -> &'static str;
    async fn validate_and_normalize(&self, raw: &Value) -> Result<Value, AdapterError>;
    fn extract_gemini_schema(&self) -> Value;
}

/// Selects the adapter for a niche, or refuses.
///
/// This returns a `Result` rather than a `Box<dyn NicheAdapter>`, and that signature is the
/// whole point of the change. It previously returned a boxed adapter unconditionally, and
/// `CustomB2B` was served by `RealEstateAdapter` -- so a B2B tenant's events were validated
/// against property rules: a freight manifest with no `squareFootage` was coerced to 2400,
/// a lease with no `listPrice` gained a `normalizedPricePerSqFt`, and the response reported
/// "Fair Housing Act Non-Discrimination Filter" as an applied guardrail when no housing
/// discrimination check had occurred. The pipeline produced a confident, wrong, legally
/// flavoured answer about a document it had never read.
///
/// The correct behaviour for a niche with no implemented adapter is to refuse it, not to
/// approximate it with a neighbouring one. A missing vertical is a known, honest gap. A
/// plausible answer in the wrong regulatory frame is a silent corruption, and it is the
/// specific failure this trait exists to make impossible.
///
/// A refusal here costs a `CustomB2B` tenant its service. That is the intended trade: it
/// cannot send us data we will answer falsely about, and the error names the reason so the
/// operator can see the gap rather than infer it from wrong output.
pub fn get_adapter(
    niche: crate::models::tenant::IndustryNiche,
) -> Result<Box<dyn NicheAdapter>, AdapterError> {
    match niche {
        crate::models::tenant::IndustryNiche::RealEstate => {
            Ok(Box::new(real_estate::RealEstateAdapter))
        }
        crate::models::tenant::IndustryNiche::Healthcare => {
            Ok(Box::new(healthcare::HealthcareAdapter))
        }
        crate::models::tenant::IndustryNiche::Logistics => {
            Ok(Box::new(logistics::LogisticsAdapter))
        }
        crate::models::tenant::IndustryNiche::CustomB2B => Err(AdapterError::NicheNotServed(
            "custom_b2b is modelled but has no implemented adapter. This runtime serves \
             real_estate, healthcare and logistics. It previously answered with the \
             real-estate adapter, which validated non-property events against property rules \
             and reported housing guardrails that were never applied."
                .to_string(),
        )),
    }
}
