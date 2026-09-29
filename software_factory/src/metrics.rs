//! Runtime metrics.
//!
//! ## Why this exists
//!
//! `NC-9` in the constitution recorded that the Rust runtime had no metrics endpoint. That
//! gap was easy to leave in place because a missing endpoint is invisible: nothing fails,
//! and the Kubernetes manifests that reference Prometheus scrape paths simply have no data
//! to collect. A dashboard that silently shows nothing is indistinguishable from a service
//! with no traffic, which is the failure mode the constitution's "no fabricated data in any
//! code path" rule is aimed at.
//!
//! ## What is measured, and what is deliberately not
//!
//! Every series here is a **real observation**. Request counts come from a counter that
//! increments on the actual request path. Uptime comes from the process clock. The tenant
//! count is the size of the live credential map. There is no default, no seeded, and no
//! plausible value anywhere in this module: if a series has no observations it renders as
//! zero, because zero is the truthful number for "this has not happened yet".
//!
//! Deliberately absent: per-tenant request counters. A tenant id in a metric label is a
//! cross-tenant information channel, and the multi-tenancy invariant in the constitution
//! treats exactly that kind of conflation as a defect. Series are aggregated by status
//! class instead, which is enough to operate the service and reveals nothing about who is
//! calling it.

use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

/// Atomic-backed counters. Lock-free so the scrape path cannot contend with request
/// handling, and so a slow scraper degrades its own numbers rather than the service's.
pub struct Metrics {
    started: Instant,
    /// `[0]`=1xx `[1]`=2xx `[2]`=3xx `[3]`=4xx `[4]`=5xx
    requests_by_class: [AtomicU64; 5],
    requests_in_flight: AtomicU64,
    /// Requests refused by the tenant guard, i.e. a credential that named no tenant.
    auth_failures_total: AtomicU64,
}

impl Metrics {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            requests_by_class: Default::default(),
            requests_in_flight: AtomicU64::new(0),
            auth_failures_total: AtomicU64::new(0),
        }
    }

    fn class_index(status: u16) -> usize {
        match status / 100 {
            1 => 0,
            2 => 1,
            3 => 2,
            4 => 3,
            _ => 4,
        }
    }
}

static METRICS: OnceLock<Metrics> = OnceLock::new();

/// The process-wide metrics registry.
pub fn metrics() -> &'static Metrics {
    METRICS.get_or_init(Metrics::new)
}

/// RAII guard that holds the in-flight gauge for the life of a request.
///
/// Decrementing on drop rather than at the end of the handler is deliberate: a handler that
/// returns early, or a request the tower drops mid-flight, still releases the gauge. A gauge
/// incremented in a middleware and decremented in the next one drifts upwards forever the
/// first time an error path is taken, and a stuck gauge is worse than no gauge because it
/// looks like a real saturation measurement.
pub struct InFlight;

impl InFlight {
    pub fn enter() -> Self {
        metrics().requests_in_flight.fetch_add(1, Ordering::Relaxed);
        Self
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        metrics().requests_in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Records one completed request, classified by HTTP status.
pub fn observe_request(status: u16) {
    metrics().requests_by_class[Metrics::class_index(status)].fetch_add(1, Ordering::Relaxed);
}

/// Records a request refused by the tenant guard.
pub fn observe_auth_failure() {
    metrics()
        .auth_failures_total
        .fetch_add(1, Ordering::Relaxed);
}

/// The observed request total for one status class, for assertions that need the raw
/// counters rather than a rendered exposition.
pub fn requests_in_class(index: usize) -> u64 {
    metrics()
        .requests_by_class
        .get(index)
        .map(|counter| counter.load(Ordering::Relaxed))
        .unwrap_or(0)
}

/// The current in-flight request count.
///
/// The in-flight gauge is the only series that can legitimately be non-zero before any
/// request has completed, so it is readable directly: a test asserts it returns to zero
/// after traffic rather than drifting, which is the failure mode a hand-incremented gauge
/// has the first time an error path is taken.
pub fn current_in_flight() -> u64 {
    metrics().requests_in_flight.load(Ordering::Relaxed)
}

/// Renders the Prometheus text exposition format (version 0.0.4).
///
/// Hand-rendered rather than pulling in a metrics crate. The exposition format is a flat
/// line-oriented text format, the series set here is small and fixed, and a new dependency
/// would have to be justified against the alternative -- which is this function. The
/// discipline in the constitution is explicit that a dependency needs a recorded
/// justification, and adding a registry framework to emit eleven lines does not clear it.
pub fn render(tenants_configured: usize, appwrite_configured: bool) -> String {
    let m = metrics();
    let uptime = m.started.elapsed().as_secs_f64();
    let mut out = String::with_capacity(1024);

    // HELP/TYPE pairs are emitted before the samples, and every series has exactly one
    // declared type, which is what a scraper requires to compute rates correctly.
    let _ = writeln!(
        out,
        "# HELP sf_build_info Build and runtime identity of this process.\n\
         # TYPE sf_build_info gauge\n\
         sf_build_info{{version=\"{}\",component=\"rust-runtime\"}} 1",
        env!("CARGO_PKG_VERSION")
    );

    let _ = writeln!(
        out,
        "# HELP sf_uptime_seconds Seconds since this process started.\n\
         # TYPE sf_uptime_seconds gauge\n\
         sf_uptime_seconds {uptime:.3}"
    );

    let _ = writeln!(
        out,
        "# HELP sf_http_requests_in_flight Requests currently being served.\n\
         # TYPE sf_http_requests_in_flight gauge\n\
         sf_http_requests_in_flight {}",
        m.requests_in_flight.load(Ordering::Relaxed)
    );

    let _ = writeln!(
        out,
        "# HELP sf_http_requests_total Completed HTTP requests by status class.\n\
         # TYPE sf_http_requests_total counter"
    );
    for (label, index) in [
        ("1xx", 0usize),
        ("2xx", 1),
        ("3xx", 2),
        ("4xx", 3),
        ("5xx", 4),
    ] {
        // All five classes are always emitted, including the zero ones. A missing series and
        // a zero series mean different things to a rate calculation, and omitting the empty
        // ones makes a dashboard's zero line ambiguous.
        let _ = writeln!(
            out,
            "sf_http_requests_total{{class=\"{label}\"}} {}",
            m.requests_by_class[index].load(Ordering::Relaxed)
        );
    }

    let _ = writeln!(
        out,
        "# HELP sf_auth_failures_total Requests refused by the tenant guard.\n\
         # TYPE sf_auth_failures_total counter\n\
         sf_auth_failures_total {}",
        m.auth_failures_total.load(Ordering::Relaxed)
    );

    let _ = writeln!(
        out,
        "# HELP sf_tenants_configured Tenants holding a credential at the request boundary.\n\
         # TYPE sf_tenants_configured gauge\n\
         sf_tenants_configured {tenants_configured}"
    );

    // Reported as a metric rather than left implicit, because an unconfigured persistence
    // layer is a degraded runtime that still answers 200 on the telemetry path.
    let _ = writeln!(
        out,
        "# HELP sf_persistence_configured Whether a database credential is present (1) or absent (0).\n\
         # TYPE sf_persistence_configured gauge\n\
         sf_persistence_configured {}",
        u8::from(appwrite_configured)
    );

    out
}
