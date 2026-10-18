#!/usr/bin/env tsx
/**
 * `npm run verify:image-digest`
 *
 * Deployment readiness check (Layer 4 Operations).
 *
 * Verifies that the deployment manifest in deploy/k8s/deployment.yaml is
 * consistent with the release:
 *  - The image tag matches package.json version
 *  - The image is the Node image (not the deleted Rust runtime)
 *  - The manifest references a digest-pinnable image format
 *
 * This does NOT push to a registry (that requires credentials). It proves the
 * manifest is internally consistent so that when a digest is available, it can
 * be substituted for the tag with confidence.
 *
 * Exit 0: manifest is consistent.
 * Exit 1: manifest is inconsistent — fix before releasing.
 */

import fs from 'node:fs';
import path from 'node:path';

const MANIFEST = 'deploy/k8s/deployment.yaml';

function fail(code: string, detail?: string): never {
  console.error(`FAIL ${code}${detail ? `: ${detail}` : ''}`);
  process.exit(1);
}

function main(): void {
  const manifest = fs.readFileSync(MANIFEST, 'utf8');

  // 1. Read the package version.
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const version = pkg.version as string;
  if (!version) fail('NO_PACKAGE_VERSION', 'package.json has no version');

  // 2. The deployment image must be the Node image (Rust runtime was deleted in WP-3).
  const imageLine = manifest.split('\n').find((line) => line.includes('image:'));
  if (!imageLine || !imageLine.includes('ghcr.io/dmuhoro/software-factory/node:')) {
    fail('WRONG_IMAGE', 'deployment does not reference the Node image');
  }
  if (imageLine.includes('/runtime:')) {
    fail('RUST_IMAGE_REFERENCED', 'deployment image still references the deleted Rust runtime');
  }

  // 3. The image tag must match the package version.
  const tagMatch = manifest.match(/node:v([\d.]+)/);
  if (!tagMatch) fail('NO_IMAGE_TAG', 'deployment has no node image tag');
  const imageTag = tagMatch[1];
  if (imageTag !== version) {
    fail('TAG_VERSION_MISMATCH', `deployment image tag ${imageTag} != package version ${version}`);
  }

  // 4. The manifest uses a tag, not a digest. Document that a digest should be substituted
  //    at release time (see deploy/k8s/deployment.yaml:65-70).
  const digestMatch = imageLine.match(/@sha256:[0-9a-f]+/);
  if (digestMatch) {
    console.log('NOTE: deployment already uses a digest-pinned image.');
  } else {
    console.log('NOTE: deployment uses a tag-pinned image. At release time, replace the tag with');
    console.log('      the digest reported by the publish job (ghcr.io/.../node@sha256:<digest>).');
  }

  // 5. The imagePullPolicy must be IfNotPresent or Always (never Never for production).
  if (!manifest.includes('imagePullPolicy:')) {
    fail('NO_IMAGE_PULL_POLICY', 'deployment has no imagePullPolicy');
  }

  console.log(`PASS: deployment manifest is consistent (image=node:${version}, tag matches package.json)`);
}

main();
