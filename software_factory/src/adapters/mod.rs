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
}

/// Swappable Domain Niche Adapter Trait
/// Every industry vertical provides a deterministic implementation of normalization and guardrails.
#[async_trait]
pub trait NicheAdapter: Send + Sync {
    fn niche_name(&self) -> &'static str;
    async fn validate_and_normalize(&self, raw: &Value) -> Result<Value, AdapterError>;
    fn extract_gemini_schema(&self) -> Value;
}

pub fn get_adapter(niche: crate::models::tenant::IndustryNiche) -> Box<dyn NicheAdapter> {
    match niche {
        crate::models::tenant::IndustryNiche::RealEstate => Box::new(real_estate::RealEstateAdapter),
        crate::models::tenant::IndustryNiche::Healthcare => Box::new(healthcare::HealthcareAdapter),
        crate::models::tenant::IndustryNiche::Logistics => Box::new(logistics::LogisticsAdapter),
        crate::models::tenant::IndustryNiche::CustomB2B => Box::new(real_estate::RealEstateAdapter),
    }
}
