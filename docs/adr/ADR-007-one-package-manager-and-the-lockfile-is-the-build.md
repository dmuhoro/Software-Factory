# ADR-007: One package manager, and the lockfile is part of the build

- **Status**: Accepted
- **Date**: 2026-09-29
- **Resolves**: NC-3, and records the reasoning the constitution's Wave 3 entry left open
- **Supersedes**: nothing

## Context

The repository tracked two lockfiles. `package-lock.json` and `bun.lock` described the same
manifest and resolved **63 of their 313 shared packages to different versions**. CI ran
`npm ci`; both Docker stages ran `bun install --frozen-lockfile`. So the image shipped a
dependency tree that no typecheck, no unit test, and none of the four HTTP harnesses had ever
run against. The pipeline was green about a build nobody deployed.

Building the images for the first time then exposed the same defect independently in the Rust
tree, and it is the reason this ADR is broader than npm.

`software_factory/Dockerfile` copied only `Cargo.toml`, never `Cargo.lock`, and passed no
`--locked`. Cargo re-resolved the dependency graph on every build. The image compiled against
whatever the registry served that day. The Rust image additionally could not be built at all:
`rust:1.78-alpine` ships Cargo 1.78, and the committed `Cargo.lock` pins `rand_pcg 0.10.2`,
whose manifest requires `edition2024` — unstabilized until Cargo 1.85.

Two independent ecosystems, one defect: **the artifact is built from something other than the
thing that was tested.**

There is a third case in the same family. In `package.json`, ten build-time packages —
`vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss`, `autoprefixer`, `react`,
`react-dom`, `recharts`, `lucide-react`, `motion` — were declared as production
dependencies. The production server bundle requires exactly three modules: `express`,
`dotenv` and `@google/genai`. The rest are compiled into `dist/assets` by the build. So
`npm ci --omit=dev` correctly installed a bundler and ~50MB of esbuild native binaries into
the runtime image. `vite` was a static top-level import in `server.ts` used only in the
development branch, so it was loaded at runtime in production to serve a SPA that does not
exist in production.

## Decision

**1. npm is the single package manager. `bun.lock` is deleted.**

**2. Every `npm ci` and every `cargo build` in a Dockerfile is preceded by a copy of the
lockfile, and `--locked` is passed to cargo on every invocation.**

An unlocked cargo build can pick up a semver-compatible bump that was never tested. A copy of
`Cargo.lock` that is not made before the build is a lockfile that does not participate in the
build. These are asserted statically, because they are not observable at runtime — an image
built without them still boots, still serves `/health`, and still runs as uid 10001. That
image passed all 12 runtime checks in the gate, which is the specific reason the static
assertions are labelled static rather than presented as runtime evidence.

**3. Build tooling is a devDependency, and must not be reachable from a static import that
runs in production.**

A package is a runtime dependency only if the production bundle requires it. The test is
mechanical: grep `dist/server.cjs` for `require(...)`. `vite` became a dynamic `import()`
inside the development branch, which is what allowed the classification to be honest.

**4. No `|| true` in any build step.**

The original Rust Dockerfile ended its dependency-cache warm-up with `|| true`, so a failed
build reported success having achieved nothing. A cache step that cannot fail is not a cache
step; it is a line that hides the next error.

**5. No hardcoded target triple.**

`--target x86_64-unknown-linux-musl` made the image unbuildable on arm64, including
Apple Silicon and Graviton. Build and run on the same distro family, glibc, with no musl
target. This also removed the `musl-dev`/`openssl-libs-static` dance, which existed only to
satisfy a cross-target link the runtime never needed.

**6. Every Dockerfile has a `.dockerignore`.**

`software_factory/` had none, so `COPY . .` shipped a 2.6GB `target/` directory on every
build — most of a 4m24s build. `Cargo.lock` is explicitly *not* ignored: excluding it would
reintroduce defect 2.

## Consequences

The Node image dropped from 119MB to 86.6MB and the Rust runtime is 36.9MB, and — the point,
not the size — neither contains a bundler.

Three of the four negative controls for this decision passed when first run. Dropping
`Cargo.lock` and `--locked` from the Rust Dockerfile produced a fully green gate, because
those properties are invisible at runtime. Restoring `|| true` also passed. A separate
control, intended to check that removing the explicit `--omit=dev` was caught, passed for an
incidental reason: `ENV NODE_ENV=production` already makes npm omit dev dependencies, so the
flag was never what was keeping them out. These are recorded because a green negative control
is as dangerous as a green test that never ran, and both of the passing ones initially
convinced me the gate was sound.

`test/l6-dependency-policy.test.ts` asserts 5 properties of the TypeScript tree. The Rust
tree is asserted by `scripts/verify-image.sh`, statically, because the observable behaviour of
a wrongly-resolved dependency graph is "it works".

## Alternatives rejected

**Keep both package managers.** Rejected: two lockfiles for one manifest is an unreconciled
policy by construction, and the disagreement is invisible until a build fails or ships.

**Commit static CIDR-style allowlists for the Rust toolchain version.** Rejected: pinning to a
version that exists today and trusting it forever is the same fiction as a committed IP
allowlist. The gate asserts the *property* — the lockfile is copied, `--locked` is passed —
and lets the base image move.

**Keep musl for a smaller static binary.** Rejected: it required a hardcoded target triple
that broke arm64, plus static-OpenSSL link gymnastics, to save space on an image that is
already 36.9MB.
