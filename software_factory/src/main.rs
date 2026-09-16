use axum::{
    routing::{get, post},
    Router,
};
use software_factory::{routes, AppState};
use std::net::SocketAddr;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Initialize structured JSON tracing subscriber for Kubernetes / Cloud logging
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer().json())
        .init();

    info!("Starting Software Factory High-Performance Concurrency Engine...");

    let gemini_key = std::env::var("GEMINI_API_KEY").unwrap_or_else(|_| "TEST_KEY".into());
    let appwrite_endpoint = std::env::var("APPWRITE_ENDPOINT").unwrap_or_else(|_| "https://cloud.appwrite.io/v1".into());
    let appwrite_project_id = std::env::var("APPWRITE_PROJECT_ID").unwrap_or_else(|_| "b2b_factory".into());

    let state = AppState::new(gemini_key, appwrite_endpoint, appwrite_project_id);

    // 2. Build Axum high-throughput routing pipeline
    let app = Router::new()
        .route("/health", get(routes::health::health_check))
        .route("/api/v1/telemetry/ingest", post(routes::telemetry::ingest_telemetry))
        .route("/api/v1/tenants", get(routes::telemetry::list_tenants))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into()).parse::<u16>()?;
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
