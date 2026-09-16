# Multi-Stage High-Performance Rust Container Build
# Stage 1: Build & Static Compilation
FROM rust:1.78-alpine AS builder

RUN apk add --no-cache musl-dev pkgconfig openssl-dev openssl-libs-static

WORKDIR /app

COPY Cargo.toml ./
# Cache dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release || true

COPY . .
RUN cargo build --release --target x86_64-unknown-linux-musl

# Stage 2: Minimalist Distroless Scratch Container
FROM alpine:3.19 AS runner

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 10001 -S factorygroup && \
    adduser -u 10001 -S factoryuser -G factorygroup

WORKDIR /app
COPY --from=builder /app/target/x86_64-unknown-linux-musl/release/software_factory /app/software_factory

USER 10001:10001

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget --spider -q http://localhost:8080/health || exit 1

ENTRYPOINT ["/app/software_factory"]
