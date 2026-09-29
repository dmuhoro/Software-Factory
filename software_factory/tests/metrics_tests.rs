//! Metrics are real observations, and this file proves that on the real request path.
//!
//! The properties under test are the ones that make a metrics endpoint worth trusting. A
//! counter that reports a plausible number regardless of traffic is worse than no metrics,
//! because an operator builds an alert on it.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    Router,
};
use software_factory::{build_router, metrics, AppState};
use tower::util::ServiceExt;

/// The registry is process-global, and Rust runs tests in a binary concurrently. Two tests
/// in this file that both measured a before/after delta would therefore see each other's
/// traffic in the difference, and the assertions would pass or fail depending on the test
/// runner's thread count -- which is the same defect that was just fixed in the integration
/// suite, in a different disguise.
///
/// Every test in this file that generates traffic takes this lock, so a delta is always the
/// delta of that one test's requests. Assertions on absolute values do not need it.
static TRAFFIC: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Held for the duration of a test that generates traffic and makes delta assertions.
async fn exclusive_traffic() -> tokio::sync::MutexGuard<'static, ()> {
    TRAFFIC.lock().await
}
fn series_value(exposition: &str, name: &str) -> Option<u64> {
    exposition
        .lines()
        .find(|line| line.starts_with(name) && !line.starts_with('#'))
        .and_then(|line| line.rsplit(' ').next())
        .and_then(|v| v.parse().ok())
}

fn state_with(keys: HashMap<String, String>, persistence: &str) -> AppState {
    AppState::with_full_config(
        "gemini-key".into(),
        "https://example.invalid/v1".into(),
        "proj_test".into(),
        keys,
        persistence.into(),
    )
}

/// THE production router, not a test-local copy of it.
///
/// This alias exists only to keep the call sites short. It resolves to
/// `software_factory::build_router`, which is the same function `main` calls, so a change to
/// the routing pipeline is a change to what these tests exercise. An earlier version of this
/// file built its own `Router::new()` with the layers spelled out again -- and a negative
/// control that deleted the metrics observer from `main.rs` passed, because `main.rs` was
/// never under test. That is a test suite that proves its own copy works.
fn app(state: AppState) -> Router {
    build_router(state)
}

fn request(method: &str, uri: &str, tenant: Option<&str>, key: Option<&str>) -> Request<Body> {
    let method = axum::http::Method::from_bytes(method.as_bytes()).unwrap();
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(t) = tenant {
        req = req.header("x-tenant-id", t);
    }
    if let Some(k) = key {
        req = req.header("x-api-key", k);
    }
    req.body(Body::empty()).unwrap()
}

fn keys() -> HashMap<String, String> {
    let mut keys = HashMap::new();
    keys.insert("tenant_re_8841".to_string(), "re-secret".to_string());
    keys
}

#[tokio::test]
async fn metrics_endpoint_serves_the_prometheus_exposition_format() {
    let _traffic = exclusive_traffic().await;
    let response = app(state_with(keys(), "appwrite-key"))
        .oneshot(request("GET", "/metrics", None, None))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(
        content_type.starts_with("text/plain"),
        "a scraper must receive text, got {content_type}"
    );
    assert!(
        content_type.contains("version=0.0.4"),
        "the exposition version must be declared, got {content_type}"
    );

    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();

    // Every series must carry HELP and TYPE. A sample with no TYPE makes a scraper treat
    // it as untyped and refuse to compute a rate from it.
    for series in [
        "sf_build_info",
        "sf_uptime_seconds",
        "sf_http_requests_total",
        "sf_http_requests_in_flight",
        "sf_auth_failures_total",
        "sf_tenants_configured",
        "sf_persistence_configured",
    ] {
        assert!(
            text.contains(&format!("# HELP {series} ")),
            "{series} is missing its HELP line"
        );
        assert!(
            text.lines()
                .any(|l| l.starts_with(&format!("# TYPE {series} "))),
            "{series} is missing its TYPE line"
        );
    }
}

#[tokio::test]
async fn request_counters_track_the_real_request_path() {
    let _traffic = exclusive_traffic().await;
    let router = app(state_with(keys(), "appwrite-key"));
    let before = axum::body::to_bytes(
        router
            .clone()
            .oneshot(request("GET", "/metrics", None, None))
            .await
            .unwrap()
            .into_body(),
        64 * 1024,
    )
    .await
    .unwrap();
    let before_text = String::from_utf8(before.to_vec()).unwrap();
    let ok_before = series_value(&before_text, "sf_http_requests_total{class=\"2xx\"}").unwrap();
    let unauthorized_before =
        series_value(&before_text, "sf_http_requests_total{class=\"4xx\"}").unwrap();
    let auth_before = series_value(&before_text, "sf_auth_failures_total").unwrap();

    // Three refused requests: the guard rejects all of them before a handler runs.
    for _ in 0..3 {
        router
            .clone()
            .oneshot(request(
                "POST",
                "/api/v1/telemetry/ingest",
                Some("tenant_re_8841"),
                Some("wrong-secret"),
            ))
            .await
            .unwrap();
    }
    // One that reaches a handler.
    router
        .clone()
        .oneshot(request("GET", "/health", None, None))
        .await
        .unwrap();

    let after = axum::body::to_bytes(
        router
            .clone()
            .oneshot(request("GET", "/metrics", None, None))
            .await
            .unwrap()
            .into_body(),
        64 * 1024,
    )
    .await
    .unwrap();
    let after_text = String::from_utf8(after.to_vec()).unwrap();

    assert_eq!(
        series_value(&after_text, "sf_http_requests_total{class=\"4xx\"}").unwrap()
            - unauthorized_before,
        3,
        "every guard refusal must be counted, including the ones that never reach a handler"
    );
    assert_eq!(
        series_value(&after_text, "sf_auth_failures_total").unwrap() - auth_before,
        3,
        "refusals must be counted at the boundary that made them, not inferred from status"
    );
    assert!(
        series_value(&after_text, "sf_http_requests_total{class=\"2xx\"}").unwrap() > ok_before,
        "the served request must be counted"
    );
}

#[tokio::test]
async fn the_in_flight_gauge_returns_to_zero_instead_of_drifting() {
    let _traffic = exclusive_traffic().await;
    let router = app(state_with(keys(), "appwrite-key"));
    let baseline = metrics::current_in_flight();

    for _ in 0..5 {
        router
            .clone()
            .oneshot(request("GET", "/health", None, None))
            .await
            .unwrap();
    }
    // Also exercise the paths that would leak a gauge if it were incremented and
    // decremented in different places: a refusal, and a route that does not exist.
    router
        .clone()
        .oneshot(request("POST", "/api/v1/telemetry/ingest", None, None))
        .await
        .unwrap();
    router
        .clone()
        .oneshot(request("GET", "/api/v1/nope", None, None))
        .await
        .unwrap();

    assert_eq!(
        metrics::current_in_flight(),
        baseline,
        "the in-flight gauge must return to its starting value, so it is not reporting a leak"
    );
}

#[tokio::test]
async fn a_404_is_counted_because_the_observer_sits_above_the_router() {
    let _traffic = exclusive_traffic().await;
    let router = app(state_with(keys(), "appwrite-key"));
    let before = axum::body::to_bytes(
        router
            .clone()
            .oneshot(request("GET", "/metrics", None, None))
            .await
            .unwrap()
            .into_body(),
        64 * 1024,
    )
    .await
    .unwrap();
    let before_text = String::from_utf8(before.to_vec()).unwrap();
    let before_4xx = series_value(&before_text, "sf_http_requests_total{class=\"4xx\"}").unwrap();

    let response = router
        .clone()
        .oneshot(request("GET", "/api/v1/does-not-exist", None, None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let after = axum::body::to_bytes(
        router
            .clone()
            .oneshot(request("GET", "/metrics", None, None))
            .await
            .unwrap()
            .into_body(),
        64 * 1024,
    )
    .await
    .unwrap();
    let after_text = String::from_utf8(after.to_vec()).unwrap();
    assert_eq!(
        series_value(&after_text, "sf_http_requests_total{class=\"4xx\"}").unwrap() - before_4xx,
        1,
        "a request that matched no route must still be observed, or the counter hides exactly \
         the traffic an operator investigates"
    );
}

#[tokio::test]
async fn metrics_report_the_real_configuration_and_never_a_placeholder() {
    let _traffic = exclusive_traffic().await;
    // Configured runtime.
    let configured = app(state_with(keys(), "appwrite-key"))
        .oneshot(request("GET", "/metrics", None, None))
        .await
        .unwrap();
    let body = axum::body::to_bytes(configured.into_body(), 64 * 1024)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert_eq!(series_value(&text, "sf_tenants_configured").unwrap(), 1);
    assert_eq!(series_value(&text, "sf_persistence_configured").unwrap(), 1);

    // Unconfigured persistence: the gauge must say 0, not 1.
    let unconfigured = app(state_with(keys(), ""))
        .oneshot(request("GET", "/metrics", None, None))
        .await
        .unwrap();
    let body = axum::body::to_bytes(unconfigured.into_body(), 64 * 1024)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert_eq!(
        series_value(&text, "sf_persistence_configured").unwrap(),
        0,
        "a runtime that cannot persist must not report that it can"
    );

    // The build version comes from the manifest, so it cannot drift from what shipped.
    assert!(
        text.contains(&format!(
            "sf_build_info{{version=\"{}\"",
            env!("CARGO_PKG_VERSION")
        )),
        "the build series must carry the crate version read at compile time"
    );
}

#[tokio::test]
async fn metrics_never_expose_a_tenant_identifier_or_a_credential() {
    let _traffic = exclusive_traffic().await;
    let state = state_with(keys(), "appwrite-key");
    let router = app(state);
    router
        .clone()
        .oneshot(request(
            "POST",
            "/api/v1/telemetry/ingest",
            Some("tenant_re_8841"),
            Some("re-secret"),
        ))
        .await
        .unwrap();

    let response = router
        .oneshot(request("GET", "/metrics", None, None))
        .await
        .unwrap();
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();

    // A tenant id in a metric label is a cross-tenant information channel, and a
    // credential in an exposition body is a credential in whatever scrapes it.
    assert!(
        !text.contains("tenant_re_8841"),
        "metrics must not carry a tenant identifier"
    );
    assert!(
        !text.contains("re-secret"),
        "metrics must not carry a credential"
    );
    assert!(
        !text.contains("proj_test"),
        "metrics must not carry the project id"
    );
}

#[tokio::test]
async fn a_server_error_is_flagged_in_the_response_so_it_can_be_alerted_on() {
    let _traffic = exclusive_traffic().await;
    // An empty persistence key makes readiness genuinely unready, so this asserts a real
    // 503 rather than a conditional that would silently prove nothing.
    let router = app(state_with(keys(), ""));

    let response = router
        .oneshot(request("GET", "/ready", None, None))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "a service that cannot persist is not ready"
    );
    assert_eq!(
        response.headers().get("x-sf-observed-error").unwrap(),
        "1",
        "a 5xx must be distinguishable without scraping the body"
    );

    // A 4xx is a client error and must NOT be flagged: flagging every non-2xx would make the
    // header meaningless and train an operator to ignore it.
    let refused = app(state_with(keys(), ""))
        .oneshot(request("POST", "/api/v1/telemetry/ingest", None, None))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
    assert!(
        refused.headers().get("x-sf-observed-error").is_none(),
        "a client error is not a service fault and must not be flagged as one"
    );
}

#[tokio::test]
async fn readiness_reports_the_running_state_and_never_a_credential() {
    let _traffic = exclusive_traffic().await;

    // Unconfigured persistence: reported degraded, naming the variable but not its value.
    let unready_router = app(state_with(keys(), ""));
    let unready = unready_router
        .oneshot(request("GET", "/ready", None, None))
        .await
        .unwrap();
    assert_eq!(unready.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = axum::body::to_bytes(unready.into_body(), 64 * 1024)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(
        text.contains("APPWRITE_API_KEY"),
        "readiness must name what is missing so an operator can fix it"
    );
    assert!(
        !text.contains("appwrite-key") && !text.contains("re-secret"),
        "readiness is a public endpoint and must never echo a credential value"
    );

    // Fully configured: ready, and the counts must be the real ones.
    let ready = app(state_with(keys(), "appwrite-key"))
        .oneshot(request("GET", "/ready", None, None))
        .await
        .unwrap();

    assert_eq!(ready.status(), StatusCode::OK);
    let body = axum::body::to_bytes(ready.into_body(), 64 * 1024)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(text.contains("\"persistence_configured\":true"));
    assert!(text.contains("\"tenants_configured\":1"));

    // No tenants provisioned is degraded, not ready: a service that refuses every write is
    // not a healthy service.
    let no_tenants_router = app(state_with(HashMap::new(), "appwrite-key"));
    let no_tenants = no_tenants_router
        .oneshot(request("GET", "/ready", None, None))
        .await
        .unwrap();

    assert_eq!(
        no_tenants.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "a service with no tenant credential is not ready to serve tenant traffic"
    );
}

#[tokio::test]
async fn the_counter_is_atomic_under_concurrent_traffic() {
    let _traffic = exclusive_traffic().await;
    // A lost increment under concurrency is a silently wrong rate, which is the failure a
    // metrics endpoint is least likely to be suspected of. 200 concurrent requests must
    // produce exactly 200 observations.
    let router = app(state_with(keys(), "appwrite-key"));
    let before = axum::body::to_bytes(
        router
            .clone()
            .oneshot(request("GET", "/metrics", None, None))
            .await
            .unwrap()
            .into_body(),
        64 * 1024,
    )
    .await
    .unwrap();
    let before_text = String::from_utf8(before.to_vec()).unwrap();
    let before_total: u64 = ["1xx", "2xx", "3xx", "4xx", "5xx"]
        .iter()
        .map(|c| {
            series_value(
                &before_text,
                &format!("sf_http_requests_total{{class=\"{c}\"}}"),
            )
            .unwrap()
        })
        .sum();

    let mut handles = Vec::new();
    for _ in 0..200 {
        // A fresh router per task: a `Router` is a Service, not a `Sync` handle, and the
        // point is to hit the SHARED process-global counter from many tasks at once.
        let shared = Arc::new(state_with(keys(), "appwrite-key"));
        handles.push(tokio::spawn(async move {
            build_router((*shared).clone())
                .oneshot(request("GET", "/health", None, None))
                .await
                .unwrap()
        }));
    }
    for handle in handles {
        handle.await.unwrap();
    }

    let after = axum::body::to_bytes(
        router
            .clone()
            .oneshot(request("GET", "/metrics", None, None))
            .await
            .unwrap()
            .into_body(),
        64 * 1024,
    )
    .await
    .unwrap();
    let after_text = String::from_utf8(after.to_vec()).unwrap();
    let after_total: u64 = ["1xx", "2xx", "3xx", "4xx", "5xx"]
        .iter()
        .map(|c| {
            series_value(
                &after_text,
                &format!("sf_http_requests_total{{class=\"{c}\"}}"),
            )
            .unwrap()
        })
        .sum();

    // 200 health requests, plus the `/metrics` scrape that opened the range. A scrape
    // renders its body before its own counter increment lands, so it appears in the *next*
    // scrape rather than its own -- which is why the opening scrape is inside this delta and
    // the closing scrape is not. The expectation is derived from that behaviour rather than
    // rounded to a convenient number: if a scrape counted itself synchronously the delta
    // would be 202, and if it never counted itself it would be 200.
    assert_eq!(
        after_total - before_total,
        201,
        "every concurrent request must be counted exactly once, and a scrape must be counted          exactly once too"
    );
    assert_eq!(
        metrics::current_in_flight(),
        0,
        "the gauge must be clean once all work has finished"
    );
    // The counters are read through an accessor rather than by reaching into the registry,
    // so the test reads the same values a scraper would.
    assert!(
        metrics::requests_in_class(0)
            + metrics::requests_in_class(1)
            + metrics::requests_in_class(2)
            + metrics::requests_in_class(3)
            + metrics::requests_in_class(4)
            >= after_total,
        "the per-class accessor must agree with the rendered exposition"
    );
}
