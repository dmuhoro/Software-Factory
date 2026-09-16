# ADR-003: High-Performance Rust & Tokio Concurrency Engine

## Status
Accepted

## Context
High-throughput telemetry ingestion from IoT reefer monitors, clinical telemetry monitors, and property MLS syndication feeds creates bursty stream profiles susceptible to event queue lag and latency spikes in garbage-collected environments.

## Decision
1. **Language & Runtime**: Implement core stream ingestion in Rust with Tokio multi-threaded asynchronous runtime.
2. **State Concurrency**: Shared tenant registry managed with `dashmap::DashMap`, providing lock-free concurrent reads across worker threads.
3. **Domain Adapters**: Implement trait-based polymorphic dispatch (`NicheAdapter`) with zero heap allocation overhead for hot path validation.
4. **Non-blocking Persistence**: Appwrite database sync is dispatched via `tokio::spawn` detached background tasks.

## Consequences
- Positive: Sub-millisecond pipeline latency, predictable memory footprint (zero GC pauses), and thread-safe memory guarantees.
- Deployment: Encapsulated in multi-stage Docker container managed by Kubernetes Horizontal Pod Autoscaler.
