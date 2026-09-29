//! # Software Factory - Core Multi-Tenant Engine
//!
//! Production-grade Rust runtime utilizing Tokio for asynchronous event streaming,
//! strict tenant partitioning, swappable domain adapters, and Gemini structured AI outputs.

pub mod adapters;
pub mod middleware;
pub mod models;
pub mod routes;
pub mod services;

use dashmap::DashMap;
use models::tenant::TenantProfile;
use std::collections::HashMap;
use std::sync::Arc;

/// Shared global application state protected by concurrent read-optimized DashMap
#[derive(Clone)]
pub struct AppState {
    pub tenants: Arc<DashMap<String, TenantProfile>>,
    /// Per-tenant credentials, keyed by tenant id. A tenant absent from this map has no
    /// credential and is therefore unwritable: the guard refuses rather than defaulting.
    pub tenant_keys: Arc<DashMap<String, String>>,
    pub gemini_api_key: String,
    pub appwrite_endpoint: String,
    pub appwrite_project_id: String,
    /// Appwrite project key. Absent means persistence cannot happen, which the pipeline
    /// reports as a refusal rather than a success.
    pub appwrite_api_key: String,
}

impl AppState {
    pub fn new(gemini_key: String, endpoint: String, project_id: String) -> Self {
        let tenants = Arc::new(DashMap::new());

        // Seed default multi-tenant enterprise partitions
        tenants.insert(
            "tenant_re_8841".to_string(),
            TenantProfile {
                id: "tenant_re_8841".to_string(),
                name: "Apex Residential Realty".to_string(),
                niche: models::tenant::IndustryNiche::RealEstate,
                tier: models::tenant::SubscriptionTier::Enterprise,
                max_rpm: 1000,
                active: true,
            },
        );
        tenants.insert(
            "tenant_hc_1042".to_string(),
            TenantProfile {
                id: "tenant_hc_1042".to_string(),
                name: "Vanguard Health Systems".to_string(),
                niche: models::tenant::IndustryNiche::Healthcare,
                tier: models::tenant::SubscriptionTier::Enterprise,
                max_rpm: 1000,
                active: true,
            },
        );
        tenants.insert(
            "tenant_log_5529".to_string(),
            TenantProfile {
                id: "tenant_log_5529".to_string(),
                name: "TransContinental Freight".to_string(),
                niche: models::tenant::IndustryNiche::Logistics,
                tier: models::tenant::SubscriptionTier::Professional,
                max_rpm: 300,
                active: true,
            },
        );

        Self {
            tenants,
            tenant_keys: Arc::new(DashMap::new()),
            gemini_api_key: gemini_key,
            appwrite_endpoint: endpoint,
            appwrite_project_id: project_id,
            appwrite_api_key: String::new(),
        }
    }

    /// Builds state with per-tenant credentials provisioned.
    ///
    /// `AppState::new` deliberately provisions no credentials, so a process that forgot to
    /// load `TENANT_API_KEYS` serves traffic with every tenant write refused rather than
    /// silently open. This constructor is the only path that installs keys.
    pub fn with_tenant_keys(
        gemini_key: String,
        endpoint: String,
        project_id: String,
        keys: HashMap<String, String>,
    ) -> Self {
        let mut state = Self::new(gemini_key, endpoint, project_id);
        state.appwrite_api_key = std::env::var("APPWRITE_API_KEY").unwrap_or_default();
        for (tenant, key) in keys {
            state.tenant_keys.insert(tenant, key);
        }
        state
    }
}
