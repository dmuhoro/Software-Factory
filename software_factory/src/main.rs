use axum::{
    middleware,
    routing::{get, post},
    Router,
};
use software_factory::middleware::tenant_guard::{parse_tenant_keys, require_tenant_auth};
use software_factory::{routes, AppState};
use std::net::SocketAddr;
use tower_http::trace::TraceLayer;
use tracing::{error, info};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// Reads a variable that has no safe default.
///
/// A missing production credential used to fall back to a placeholder, so the process
/// started, served traffic, and returned a canned success that looked like a real AI
/// response. Refusing to start turns a silent wrong answer into a failed deploy.
fn required_env(name: &str) -> anyhow::Result<String> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Ok(value),
        _ => {
            error!(variable = name, "Refusing to start: a required credential is not configured");
            anyhow::bail!("{name} must be set to a non-empty value")
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Initialize structured JSON tracing subscriber for Kubernetes / Cloud logging
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer().json())
        .init();

    info!("Starting Software Factory High-Performance Concurrency Engine...");

    let gemini_key = required_env("GEMINI_API_KEY")?;
    let appwrite_endpoint = required_env("APPWRITE_ENDPOINT")?;
    let appwrite_project_id = required_env("APPWRITE_PROJECT_ID")?;
    let tenant_keys_spec = required_env("TENANT_API_KEYS")?;

    // A malformed or ambiguous credential map is a startup failure, not a warning: half of
    // a credential set is indistinguishable from none, and the tenants missing from it are
    // silently unwritable.
    let tenant_keys = parse_tenant_keys(&tenant_keys_spec).map_err(|reason| {
        error!(%reason, "Refusing to start: TENANT_API_KEYS is invalid");
        anyhow::anyhow!(reason)
    })?;
    if tenant_keys.is_empty() {
        error!("Refusing to start: TENANT_API_KEYS provisioned no credentials");
        anyhow::bail!("TENANT_API_KEYS must provision at least one tenant credential");
    }
    info!(
        tenants = tenant_keys.len(),
        "Provisioned per-tenant credentials at the request boundary"
    );

    let state = AppState::with_tenant_keys(
        gemini_key,
        appwrite_endpoint,
        appwrite_project_id,
        tenant_keys,
    );

    // 2. Build Axum high-throughput routing pipeline.
    //
    // The tenant guard is layered over the router here, which is the only layer that is on
    // the real request path. It previously existed in `middleware/tenant_guard.rs` and was
    // never applied, so the telemetry endpoint accepted writes for any tenant from any
    // caller. `route_layer` is used rather than `layer` so the guard runs after routing
    // has matched, and public paths are skipped inside the guard.
    let app = Router::new()
        .route("/health", get(routes::health::health_check))
        .route("/ready", get(routes::health::readiness_check))
        .route("/api/v1/telemetry/ingest", post(routes::telemetry::ingest_telemetry))
        .route("/api/v1/tenants/me", get(routes::telemetry::current_tenant))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_tenant_auth))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!(%addr, "Listening for concurrent multi-niche telemetry streams");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C signal handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("Signal received: initiating graceful shutdown drain of Tokio worker pools");
}
