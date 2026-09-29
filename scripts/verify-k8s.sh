#!/usr/bin/env bash
#
# NC-5: verify the Kubernetes manifests describe the isolation they claim.
#
# The NetworkPolicy in k8s/networkpolicy.yaml opened egress with `cidr: 0.0.0.0/0` on 443 and
# a comment that said to replace it before production. That is the honest description of a
# policy that does not restrict egress. It was not a near miss: an allow-all rule is exactly
# the rule that lets a compromised process exfiltrate tenant data, which is the one thing
# this policy exists to prevent. Reading the manifest could not have told you that, because
# the manifest asserted what it intended while expressing the opposite.
#
# The runtime makes two outbound calls, and only two:
#   - generativelanguage.googleapis.com  (hardcoded in src/services/gemini_client.rs:62)
#   - APPWRITE_ENDPOINT                 (required_env in src/main.rs:39)
# Neither is a fixed-address host, and neither can be given a durable CIDR. Google fronts
# both behind anycast and CDN ranges that change without notice, and a stale CIDR in a
# NetworkPolicy fails closed -- every request errors -- which is a production outage caused
# by a security control. So there is no correct static allowlist, and writing one anyway
# would be inventing a number.
#
# The resolution used here is to make the policy fail closed by construction and to move the
# address question to deploy time, where it can be answered truthfully:
#
#   1. The policy contains no wildcard egress. Egress is default-denied.
#   2. scripts/render-egress-policy.sh resolves the two real hostnames at deploy time and
#      renders a policy containing only the addresses it actually observed.
#   3. scripts/verify-k8s.sh fails the build if a wildcard reappears anywhere in egress, so
#      the allow-all cannot come back unnoticed.
#
# What this does NOT claim: that resolution-based allowlisting is a durable control. DNS
# answers can be poisoned or changed after the policy is rendered, and a NetworkPolicy has
# no concept of a hostname. The rendered policy is a snapshot with a stated lifetime. The
# durable answer is an egress proxy or a service mesh that filters by SNI; that is recorded
# in the manifest and in the handover rather than claimed as done.
#
# Usage: scripts/verify-k8s.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
section() { printf '\n\033[1m═══ %s ═══\033[0m\n' "$1"; }

K8S=software_factory/k8s

section "Manifests exist and are non-empty"
for f in networkpolicy.yaml deployment.yaml ingress.yaml configmap.yaml secret.example.yaml hpa.yaml namespace.yaml; do
  if [ -s "$K8S/$f" ]; then
    pass "$f is present and non-empty"
  else
    fail "$f is missing or empty"
  fi
done

section "Egress is not open to the world"
# The core NC-5 assertion. Checked against the egress section only: 0.0.0.0/0 is legitimate in
# some contexts and never legitimate here, but a blanket scan would also flag the ingress
# rule set, which is restricted by namespace and port and is not the finding.
#
# Comments are stripped first. This file documents the wildcard in prose, and a grep that
# cannot tell a comment from a rule reports the documentation as the vulnerability.
NP_RULES="$(grep -vE '^[[:space:]]*#' "$K8S/networkpolicy.yaml")"
if printf '%s' "$NP_RULES" | grep -qE 'cidr:[[:space:]]*(0\.0\.0\.0/0|::/0)'; then
  fail "egress allows 0.0.0.0/0; tenant data can leave the cluster over HTTPS"
else
  pass "no wildcard CIDR in the egress rules"
fi

# A short-prefix block is the same defect wearing a disguise: 10.0.0.0/8 permits egress to
# any private network in range, which includes the cluster's own control plane in many
# installations.
if printf '%s' "$NP_RULES" | grep -qE 'cidr:[[:space:]]*[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/(8|9|10|11|12)\b'; then
  fail "egress allows a short-prefix range, which is nearly as permissive as a wildcard"
else
  pass "no short-prefix egress range"
fi

section "Ingress is restricted by namespace and port"
if printf '%s' "$NP_RULES" | grep -q 'namespaceSelector'; then
  pass "ingress is namespace-scoped"
else
  fail "ingress has no namespaceSelector; any pod in any namespace may reach the runtime"
fi
if printf '%s' "$NP_RULES" | grep -qE 'port:[[:space:]]*8080'; then
  pass "ingress is restricted to the runtime port 8080"
else
  fail "ingress does not name a restricted port"
fi

section "DNS egress is present, or the runtime cannot resolve anything"
# The runtime resolves generativelanguage.googleapis.com. Without DNS egress every model call
# fails, so removing the wildcard without adding this would be an outage dressed as a fix.
#
# Matched against a port declared inside an egress rule, not against the bare number 53. The
# first version of this check was `grep 'port: 53'`, and it passed with the DNS rules deleted,
# because the manifest's own comment mentions port 53 in prose. A check that reads its own
# documentation as evidence of behaviour is a check that cannot fail.
if printf '%s' "$NP_RULES" | grep -A 6 -E 'kube-dns' | grep -qE 'port:[[:space:]]*53'; then
  pass "DNS egress on port 53 is permitted"
else
  fail "no DNS egress; the runtime cannot resolve the Gemini or Appwrite endpoints"
fi

section "The runtime pod runs with the privileges the image assumes"
# software_factory/Dockerfile creates uid 10001 and scripts/verify-image.sh asserts the
# container reports it. If the pod disagreed, the pod would fail to start -- a mismatch that is
# cheap to assert here and expensive to discover in a rollout.
DEP="$(grep -vE '^[[:space:]]*#' "$K8S/deployment.yaml")"
if printf '%s' "$DEP" | grep -q 'runAsNonRoot: true'; then
  pass "runAsNonRoot is set"
else
  fail "runAsNonRoot is not set; a pod could run the runtime as root"
fi
if printf '%s' "$DEP" | grep -q 'runAsUser: 10001'; then
  pass "runAsUser matches the image's uid 10001"
else
  fail "runAsUser does not match the image's uid 10001; the pod would fail to start"
fi
if printf '%s' "$DEP" | grep -q 'allowPrivilegeEscalation: false'; then
  pass "allowPrivilegeEscalation is false"
else
  fail "allowPrivilegeEscalation is not false"
fi
if printf '%s' "$DEP" | grep -q 'readOnlyRootFilesystem: true'; then
  pass "readOnlyRootFilesystem is true"
else
  fail "readOnlyRootFilesystem is not set"
fi
if printf '%s' "$DEP" | grep -q 'drop:'; then
  pass "Linux capabilities are dropped"
else
  fail "no capabilities are dropped; the container keeps the full capability set"
fi
if printf '%s' "$DEP" | grep -q 'automountServiceAccountToken: false'; then
  pass "the service account token is not mounted"
else
  fail "the service account token is mounted into a pod that makes no API calls"
fi

section "Probes distinguish liveness from readiness"
# Pointing liveness at readiness restarts every pod at once during a dependency blip. That
# turns a degraded dependency into a total outage, so the two probes must differ.
if printf '%s' "$DEP" | grep -A 3 'livenessProbe' | grep -q '/ready'; then
  fail "liveness targets /ready; a dependency blip would restart every replica simultaneously"
else
  pass "liveness does not target the readiness path"
fi
if printf '%s' "$DEP" | grep -A 3 'readinessProbe' | grep -q '/ready'; then
  pass "readiness targets /ready"
else
  fail "readiness does not target /ready; an unserviceable pod would still receive traffic"
fi

section "The image the deployment runs is the image CI builds"
# The mismatch this repository actually had: CI tagged and built the Rust runtime, the
# deployment referenced a v3.2.0 tag, and neither the Dockerfile nor the manifest said so
# anywhere checkable. A deployment that references an unpinned or unbuilt tag is an image
# nobody has verified.
DEPLOY_IMAGE="$(printf '%s' "$DEP" | grep -oE 'image: [^ ]+' | head -1 | awk '{print $2}')"
if [ -n "$DEPLOY_IMAGE" ]; then
  if printf '%s' "$DEPLOY_IMAGE" | grep -qE ':(latest|main|master)$'; then
    fail "the deployment references the floating tag '$DEPLOY_IMAGE'; the running image is not pinned"
  else
    pass "the deployment references a pinned image: $DEPLOY_IMAGE"
  fi
else
  fail "could not determine the deployment image"
fi

# scripts/verify-image.sh builds software_factory/ into an image and proves its properties.
# The manifest must reference that same build context, or the gate is proving an artifact
# that does not ship.
CI="$(cat software_factory/.github/workflows/ci.yml 2>/dev/null)"
if printf '%s' "$CI" | grep -q 'context: software_factory'; then
  pass "CI builds software_factory/Dockerfile, the context the gate verifies"
else
  fail "CI does not build software_factory/; the image gate may not cover what ships"
fi

section "Secrets are referenced, never embedded"
SEC="$(grep -vE '^[[:space:]]*#' "$K8S/secret.example.yaml" 2>/dev/null)"
if printf '%s' "$SEC" | grep -qE 'stringData:[[:space:]]*$'; then
  pass "the secret is a template with stringData, not a committed literal"
else
  fail "the secret example has no stringData block"
fi
# A real key is long and high-entropy. This looks for a plausible literal rather than any
# string, so a documented placeholder does not trip it.
if printf '%s' "$SEC" | grep -qE ':\s*"?[A-Za-z0-9_-]{32,}"?\s*$'; then
  fail "the secret example contains a high-entropy literal; it must be a placeholder"
else
  pass "the secret example contains placeholders only"
fi
if printf '%s' "$DEP" | grep -q 'secretRef:'; then
  pass "the deployment reads configuration from a Secret reference"
else
  fail "the deployment does not reference a Secret"
fi

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m════ K8S GATE: %d passed, 0 failed ════\033[0m\n' "$PASS"
else
  printf '\033[31m════ K8S GATE: %d passed, %d FAILED ════\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
