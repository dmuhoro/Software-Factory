#!/usr/bin/env bash
#
# NC-5: render a NetworkPolicy whose egress allowlist is observed, not guessed.
#
# The runtime calls exactly two hosts:
#   - generativelanguage.googleapis.com (src/services/gemini_client.rs:62)
#   - APPWRITE_ENDPOINT                (required_env, src/main.rs:39)
#
# A NetworkPolicy addresses CIDRs and has no concept of a hostname, and both of these are
# behind CDN and anycast ranges that change without notice. So the address list cannot be
# written down in a committed file without it becoming fiction, and a wrong CIDR denies
# production traffic rather than allowing extra traffic. Both failure directions are bad, and
# the second is the dangerous one: an allowlist that silently stops matching is a control that
# stopped existing.
#
# This script resolves the two names at deploy time and renders a policy from the answers.
# That is a snapshot, and it says so. It is honest, reproducible, and it fails visibly when
# stale. It is not a substitute for an egress proxy that filters by SNI, which is the durable
# answer and is recorded as an open item.
#
# Usage:
#   scripts/render-egress-policy.sh [--endpoint https://cloud.appwrite.io/v1] [-o out.yaml]
#
# With no -o, the policy is written to stdout for review. Nothing is applied to a cluster by
# this script; applying is a separate, deliberate step.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUTPUT=""
APPWRITE_ENDPOINT="https://cloud.appwrite.io/v1"
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output) OUTPUT="${2:-}"; shift 2 ;;
    --endpoint)  APPWRITE_ENDPOINT="${2:-}"; shift 2 ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

# Fail closed: an endpoint with no host in it is a configuration error, and rendering a
# policy that permits nothing because the hostname was empty would look identical to a
# successful restrictive render.
APPWRITE_HOST="$(printf '%s' "$APPWRITE_ENDPOINT" | sed -E 's#^https?://##; s#/.*$##')"
if [ -z "$APPWRITE_HOST" ]; then
  printf 'refusing to render: APPWRITE_ENDPOINT has no hostname (%s)\n' "$APPWRITE_ENDPOINT" >&2
  exit 1
fi

GEMINI_HOST="generativelanguage.googleapis.com"

if ! command -v dig >/dev/null 2>&1 && ! command -v host >/dev/null 2>&1; then
  printf 'refusing to render: neither dig nor host is available to resolve the destinations.\n' >&2
  printf 'A rendered policy must be observed, not assumed. Install dnsutils, or run this from a host that can resolve.\n' >&2
  exit 1
fi

resolve() {
  local HOST="$1" IPS=""
  if command -v dig >/dev/null 2>&1; then
    IPS="$(dig +short "$HOST" A 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)"
    if [ -z "$IPS" ]; then
      IPS="$(dig +short "$HOST" AAAA 2>/dev/null | grep -E '^[0-9a-fA-F:]+$' || true)"
    fi
  else
    IPS="$(host "$HOST" 2>/dev/null | awk '/has address|has IPv6 address/ {print $NF}' || true)"
  fi
  printf '%s' "$IPS"
}

GEMINI_IPS="$(resolve "$GEMINI_HOST")"
APPWRITE_IPS="$(resolve "$APPWRITE_HOST")"

# Fail closed on an unresolvable destination. An empty allowlist renders as "deny all HTTPS",
# which is indistinguishable from a correct restrictive policy to anyone reading the output.
# It would also be a production outage, so the render must stop instead.
if [ -z "$GEMINI_IPS" ]; then
  printf 'refusing to render: %s did not resolve. The policy would deny all model calls.\n' "$GEMINI_HOST" >&2
  exit 1
fi
if [ -z "$APPWRITE_IPS" ]; then
  printf 'refusing to render: %s did not resolve. The policy would deny all Appwrite calls.\n' "$APPWRITE_HOST" >&2
  exit 1
fi

to_cidrs() {
  printf '%s' "$1" | tr ' ' '\n' | grep -v '^$' | while read -r IP; do
    case "$IP" in
      *:*) printf '        - ipBlock:\n            cidr: %s/128\n' "$IP" ;;
      *)   printf '        - ipBlock:\n            cidr: %s/32\n' "$IP" ;;
    esac
  done
}

echo "rendered from live DNS at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
echo "  $GEMINI_HOST -> $(printf '%s' "$GEMINI_IPS" | tr '\n' ' ')" >&2
echo "  $APPWRITE_HOST -> $(printf '%s' "$APPWRITE_IPS" | tr '\n' ' ')" >&2
cat >&2 <<'WARN'

WARNING: these are CDN and anycast addresses. They change without notice, and this file is a
snapshot of one moment. Re-render on a schedule and after any incident. When a resolved
address stops matching, egress is denied and model calls fail -- the control fails closed, and
that outage is the signal to re-render. A durable answer is an egress proxy or service mesh
that filters by SNI; this is not it.
WARN

render() {
  cat <<EOF
# GENERATED FILE -- do not edit by hand and do not commit.
# Produced by scripts/render-egress-policy.sh from live DNS resolution.
# Source of truth: software_factory/k8s/networkpolicy.yaml
#
# Any '0.0.0.0/0' or '::/0' here means the render regressed to an allow-all. It is not
# written by this script and must never be added by hand: an allow-all egress rule lets a
# compromised process exfiltrate tenant data, which is the one thing this policy prevents.
# scripts/verify-k8s.sh fails the build if one appears.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: software-factory-runtime-egress
  namespace: factory-production
  labels:
    app.kubernetes.io/name: software-factory-runtime
    app.kubernetes.io/part-of: b2b-saas-platform
    software-factory/generated: "true"
  annotations:
    software-factory/rendered-at: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    software-factory/rendered-from: "$GEMINI_HOST,$APPWRITE_HOST"
    software-factory/snapshot-notice: "Addresses are observed, not authoritative. Re-render regularly."
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: software-factory-runtime
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    # $GEMINI_HOST
    - to:
$(to_cidrs "$GEMINI_IPS")
      ports:
        - protocol: TCP
          port: 443
    # $APPWRITE_HOST
    - to:
$(to_cidrs "$APPWRITE_IPS")
      ports:
        - protocol: TCP
          port: 443
EOF
}

if [ -n "$OUTPUT" ]; then
  render > "$OUTPUT"
  printf 'wrote %s\n' "$OUTPUT" >&2
else
  render
fi
