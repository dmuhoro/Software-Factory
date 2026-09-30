//! Request-observation middleware.
//!
//! This sits on the real request path -- it is layered over the router in `main.rs`, the
//! same layer that the tenant guard uses -- rather than in a helper that only a test calls.
//! A counter incremented inside a handler would miss every request that never reached one:
//! a 404, a refusal from the guard, a method that did not match. Those are exactly the
//! requests an operator needs to see, so the observation happens above the handlers.

use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};

use crate::metrics::{self, InFlight};

/// Counts one request and keeps the in-flight gauge accurate for its whole lifetime.
///
/// The `InFlight` guard is bound before the request is handed on, so a request that is
/// dropped by a timeout or an early return still releases the gauge on drop.
pub async fn observe(request: Request, next: Next) -> Response {
    let _in_flight = InFlight::enter();
    let mut response = next.run(request).await;
    let status = response.status();
    metrics::observe_request(status.as_u16());
    // Server errors are the ones an operator must be able to alert on, so they are
    // distinguishable in the response headers without scraping the body. This says the
    // service observed the fault; it does not claim to have fixed or logged it.
    if status.is_server_error() {
        response
            .headers_mut()
            .insert("x-sf-observed-error", header::HeaderValue::from_static("1"));
    }
    response
}

/// Counts a refusal produced by the tenant guard.
///
/// Called from the guard itself rather than inferred from the status code, because a 401
/// from this service means "credential did not authenticate" while a 401 from a proxy
/// means something else entirely. Counting only what this process decided keeps the series
/// honest.
pub fn note_auth_failure(status: StatusCode) {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        metrics::observe_auth_failure();
    }
}

/// Re-exported so a test can assert the gauge returns to zero rather than drifting.
pub use crate::metrics::current_in_flight;
