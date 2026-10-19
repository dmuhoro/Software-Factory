# ADR-018: Self-serve tenant provisioning via POST /api/tenants

## Status

Accepted.

## Context

Before this change, tenants could only be created by calling
`TenantService.registerTenant` directly in code. There was no operator-free path
to onboard a new builder: the platform key holder had to provision each tenant and
hand-deliver a root API key out of band. That made the product unusable by anyone
except the person with server access.

## Decision

A public `POST /api/tenants` endpoint accepts `name`, `niche`, and optional `tier`,
generates a tenant id, hashes a root API key with salted scrypt, registers the
tenant durably, and returns the plaintext key exactly once — never stored, logged,
or recoverable.

- `POST /api/tenants` is publicly accessible (`isPublicPath` allows it for POST
  only); `GET /tenants` remains tenant-authenticated so a caller cannot enumerate
  partitions without a credential.
- The generated root key is shown in the response body exactly once. The process
  never persists, logs, or re-emits it.
- A duplicate tenant name is refused with 409; an invalid niche or tier is refused
  with 400.
- `isPublicPath(req.path, req.method)` now takes the HTTP method so that only
  `POST /tenants` is public; `GET /tenants` stays protected by tenant auth.

## Consequences

- Positive: a new builder can self-serve a tenant and a root API key without server
  access. This is the prerequisite for external users and multi-tenancy.
- Negative: the root key is shown once; if the caller loses it, they must provision
  a new tenant or have an operator rotate credentials out of band. There is no
  "forgot password" for root keys.
- Recovery: `TenantService.revokeCredential(tenantId)` clears the digest so the
  lost key can never authenticate again; a new key can then be provisioned.

## Related

- `src/api/routes/tenants.routes.ts` — the route
- `src/api/middleware/tenantAuth.ts` — `isPublicPath` with method parameter
- `src/utils/tenantCredentials.ts` — salted scrypt hashing
- Sprint 34, WP-8 (P0 Identity)
