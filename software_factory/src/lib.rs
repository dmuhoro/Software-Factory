//! # Software Factory - Core Multi-Tenant Engine
//!
//! Production-grade Rust runtime utilizing Tokio for asynchronous event streaming,
//! strict tenant partitioning, swappable domain adapters, and Gemini structured AI outputs.

pub mod adapters;
pub mod metrics;
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
    ///
    /// The persistence key is read from the environment. That is the right source for a
    /// real process and the wrong source for a constructor: it made the state of this
    /// service depend on ambient process state that no caller can see or control, and it
    /// made two tests that each set `APPWRITE_API_KEY` interfere with each other. The
    /// read is therefore confined to `main`, which is the only place that legitimately owns
    /// the process environment, and `with_full_config` takes the key as a parameter.
    /// Callers that genuinely want the environment value should ask for it explicitly.
    pub fn with_tenant_keys(
        gemini_key: String,
        endpoint: String,
        project_id: String,
        keys: HashMap<String, String>,
    ) -> Self {
        Self::with_full_config(gemini_key, endpoint, project_id, keys, String::new())
    }

    /// Builds state with every credential explicit, including the persistence key.
    ///
    /// The key is a parameter rather than an environment read so that the state of the
    /// service is fully determined by its inputs. A constructor that consults ambient
    /// process state cannot be tested in parallel with anything else that touches the same
    /// variable, and a test that has to run alone to be correct is a test whose correctness
    /// is a property of the test runner's thread count.
    pub fn with_full_config(
        gemini_key: String,
        endpoint: String,
        project_id: String,
        keys: HashMap<String, String>,
        appwrite_key: String,
    ) -> Self {
        let mut state = Self::new(gemini_key, endpoint, project_id);
        state.appwrite_api_key = appwrite_key;
        for (tenant, key) in keys {
            state.tenant_keys.insert(tenant, key);
        }
        state
    }
}

/// Builds the production router: every route, the tenant guard, and the metrics observer.
///
/// This lives in the library rather than in `main.rs` so that it is the *only* definition of
/// the routing pipeline. It was previously written inline in `main.rs`, which meant no test
/// could exercise it: the test suite built its own router, and a negative control that
/// deleted the metrics observer from `main.rs` still passed, because `main.rs` was not under
/// test at all. A test suite that constructs its own copy of the thing it claims to be
/// testing proves the copy works.
///
/// `main` calls this, so the router that serves traffic and the router that is tested are the
/// same value. Removing a layer from here now fails the tests.
///
/// Layer order is deliberate and load-bearing:
///
/// * `route_layer` for the guard, so it runs after routing matches and the public-path
///   allowlist in `tenant_guard` applies to matched routes only.
/// * `layer` for the observer, so it wraps the whole router and sees requests the guard
///   refuses and requests that match no route. A counter layered inside the router would
///   miss exactly the traffic an operator investigates during an incident.
pub fn build_router(state: AppState) -> axum::Router {
    use axum::routing::{get, post};
    use middleware::observe::observe as observe_request;
    use middleware::tenant_guard::require_tenant_auth;

    axum::Router::new()
        .route("/health", get(routes::health::health_check))
        .route("/ready", get(routes::health::readiness_check))
        .route("/metrics", get(routes::health::metrics_handler))
        .route(
            "/api/v1/telemetry/ingest",
            post(routes::telemetry::ingest_telemetry),
        )
        .route("/api/v1/tenants/me", get(routes::telemetry::current_tenant))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_tenant_auth,
        ))
        .layer(axum::middleware::from_fn(observe_request))
        .with_state(state)
}
