//! # Software Factory - Core Multi-Tenant Engine
//!
//! Production-grade Rust runtime utilizing Tokio for asynchronous event streaming,
//! strict tenant partitioning, swappable domain adapters, and Gemini structured AI outputs.

pub mod adapters;
pub mod middleware;
pub mod models;
pub mod routes;
pub mod services;

use std::sync::Arc;
use dashmap::DashMap;
use models::tenant::TenantProfile;

/// Shared global application state protected by concurrent read-optimized DashMap
#[derive(Clone)]
pub struct AppState {
    pub tenants: Arc<DashMap<String, TenantProfile>>,
    pub gemini_api_key: String,
    pub appwrite_endpoint: String,
    pub appwrite_project_id: String,
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
            gemini_api_key: gemini_key,
            appwrite_endpoint: endpoint,
            appwrite_project_id: project_id,
        }
    }
}
