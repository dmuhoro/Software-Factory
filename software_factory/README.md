# Software Factory - High-Performance Rust Concurrency Engine

## Architecture Overview
The Software Factory Rust engine is a production-grade multi-tenant B2B SaaS runtime engineered for extreme concurrency, strict data isolation, and deterministic AI transformation.

### Core Pillars
1. **Tokio Async Runtime**: Non-blocking concurrent stream processing, threadpool task distribution, and graceful drain lifecycle.
2. **Zero-Conflation Isolation**: Tenant memory boundaries backed by DashMap, prohibiting cross-tenant data leakage.
3. **Swappable Domain Adapters**: Dynamic trait-based adapters (`RealEstateAdapter`, `HealthcareAdapter`, `LogisticsAdapter`) isolating industry constraints.
4. **Structured Gemini Intelligence**: Direct integration with Google Gemini 1.5 Pro / 3.8 Flash with deterministic JSON schemas.
5. **Appwrite Multi-Tenant Synchronization**: Asynchronous persistence enforcing document-level attribute permissions (`team:{tenant_id}/member`).
6. **Kubernetes & Cloud Native**: Includes Docker multi-stage build, HPA autoscaling (3 to 50 replicas), and GitHub Actions CI/CD.

## Running Tests
```bash
cargo test --verbose
```

## Running Service Locally
```bash
export GEMINI_API_KEY="your-gemini-key"
export APPWRITE_ENDPOINT="https://cloud.appwrite.io/v1"
export APPWRITE_PROJECT_ID="b2b_factory"
cargo run --release
```
