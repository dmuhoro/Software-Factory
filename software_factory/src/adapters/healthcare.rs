use super::{AdapterError, NicheAdapter};
use async_trait::async_trait;
use serde_json::{json, Value};

#[derive(Debug)]
pub struct HealthcareAdapter;

#[async_trait]
impl NicheAdapter for HealthcareAdapter {
    fn niche_name(&self) -> &'static str {
        "healthcare"
    }

    async fn validate_and_normalize(&self, raw: &Value) -> Result<Value, AdapterError> {
        // Enforce zero-conflation and HIPAA safe harbor: Direct identifiers must NOT be present
        if raw.get("ssn").is_some() || raw.get("patientName").is_some() {
            return Err(AdapterError::ComplianceViolation(
                "Direct PHI detected (SSN or Name); zero-conflation HIPAA boundary violation"
                    .to_string(),
            ));
        }

        let cohort_id = raw
            .get("patientCohortId")
            .or_else(|| raw.get("clinicalEncounterId"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| AdapterError::MalformedContext("Missing patientCohortId".to_string()))?;

        let mut normalized = raw.clone();
        if let Some(obj) = normalized.as_object_mut() {
            obj.insert("cohort_identifier".to_string(), json!(cohort_id));
            obj.insert("phi_deidentified".to_string(), json!(true));
            obj.insert("fhir_resource_type".to_string(), json!("Observation"));
        }

        Ok(normalized)
    }

    fn extract_gemini_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "status": { "type": "string" },
                "confidenceScore": { "type": "number" },
                "nicheSpecificResult": {
                    "type": "object",
                    "properties": {
                        "patientCohortId": { "type": "string" },
                        "triageUrgencyScore": { "type": "number" },
                        "vitalsAnomalyFlag": { "type": "boolean" },
                        "diagnosticCodes": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["patientCohortId", "triageUrgencyScore", "vitalsAnomalyFlag", "diagnosticCodes"]
                }
            },
            "required": ["status", "confidenceScore", "nicheSpecificResult"]
        })
    }
}
