use software_factory::middleware::tenant_guard::parse_tenant_keys;
use software_factory::{build_router, AppState};
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
            error!(
                variable = name,
                "Refusing to start: a required credential is not configured"
            );
            anyhow::bail!("{name} must be set to a non-empty value")
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Initialize structured JSON tracing subscriber for Kubernetes / Cloud logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
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

    // main is the only place that legitimately owns the process environment, so this is
    // where the persistence key is read. The AppState constructor takes it as a parameter
    // so that the state of the service is a function of its inputs rather than of ambient
    // process state.
    let appwrite_key = required_env("APPWRITE_API_KEY")?;
    let state = AppState::with_full_config(
        gemini_key,
        appwrite_endpoint,
        appwrite_project_id,
        tenant_keys,
        appwrite_key,
    );

    // 2. Build the routing pipeline.
    //
    // `build_router` is the single definition of this pipeline and lives in the library so
    // the test suite exercises the router that actually serves traffic. It was inline here
    // before, which meant the tests were testing a copy of it and a negative control against
    // this file could not fail.
    let app = build_router(state).layer(TraceLayer::new_for_http());

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
