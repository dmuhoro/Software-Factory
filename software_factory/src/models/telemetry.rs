use super::tenant::IndustryNiche;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestPayload {
    pub tenant_id: String,
    pub niche: IndustryNiche,
    pub event_type: String,
    pub idempotency_key: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformationResponse {
    pub status: String,
    pub correlation_id: String,
    pub tenant_id: String,
    pub niche: IndustryNiche,
    pub transformation_id: String,
    pub duration_ms: u64,
    pub output: Value,
}
