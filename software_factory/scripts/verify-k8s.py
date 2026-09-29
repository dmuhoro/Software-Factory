#!/usr/bin/env python3
"""Layer 4: static checks on the Kubernetes manifests.

`kubectl` and `kubeconform` are not available in this environment, so these checks parse
the manifests with PyYAML and assert the specific properties that make a deployment safe.
Each assertion names the failure it prevents, so a future edit that reintroduces the
problem fails here rather than in production.
"""

import sys
import pathlib

import yaml

K8S = pathlib.Path(__file__).resolve().parent.parent / "k8s"

failures = []
checks = 0


def check(condition, description, detail=""):
    global checks
    checks += 1
    if not condition:
        failures.append(f"{description}{f' -> {detail}' if detail else ''}")


def load(name):
    with open(K8S / name) as handle:
        return list(yaml.safe_load_all(handle))


docs = {name: load(name) for name in [
    "namespace.yaml", "deployment.yaml", "hpa.yaml", "ingress.yaml",
    "configmap.yaml", "networkpolicy.yaml", "secret.example.yaml",
]}

# Every file must be valid YAML and declare a kind.
for name, parsed in docs.items():
    for doc in parsed:
        check(doc is not None and "kind" in doc, f"{name} must contain a resource with a kind")
        check(doc is not None and "apiVersion" in doc, f"{name} must declare an apiVersion")

deployment = docs["deployment.yaml"][0]
pod_spec = deployment["spec"]["template"]["spec"]
container = pod_spec["containers"][0]

# Readiness must not be the liveness path. /health answers 200 whenever the process is
# alive, so a pod missing its configuration would still be sent traffic.
check(
    container["readinessProbe"]["httpGet"]["path"] == "/ready",
    "readinessProbe must target /ready, not the liveness path",
    container["readinessProbe"]["httpGet"]["path"],
)
check(
    container["livenessProbe"]["httpGet"]["path"] == "/health",
    "livenessProbe must target /health",
    container["livenessProbe"]["httpGet"]["path"],
)
for probe in ("livenessProbe", "readinessProbe", "startupProbe"):
    check(probe in container, f"container must define a {probe}")

# Container hardening.
security = container.get("securityContext", {})
check(security.get("allowPrivilegeEscalation") is False, "allowPrivilegeEscalation must be false")
check(security.get("readOnlyRootFilesystem") is True, "readOnlyRootFilesystem must be true")
check(security.get("privileged") is False, "privileged must be false")
check(
    "ALL" in (security.get("capabilities") or {}).get("drop", []),
    "all Linux capabilities must be dropped",
)
# readOnlyRootFilesystem with no writable /tmp breaks libraries that expect one.
check(
    any(m["mountPath"] == "/tmp" for m in container.get("volumeMounts", [])),
    "a read-only root needs a writable /tmp volumeMount",
)
check(
    any(v["name"] == "tmp" for v in pod_spec.get("volumes", [])),
    "the /tmp volumeMount must be backed by a volume",
)

# Pod hardening.
pod_security = pod_spec.get("securityContext", {})
check(pod_security.get("runAsNonRoot") is True, "pod must run as non-root")
check(
    pod_security.get("seccompProfile", {}).get("type") == "RuntimeDefault",
    "pod must use the RuntimeDefault seccomp profile",
)
check(
    pod_spec.get("automountServiceAccountToken") is False,
    "the service account token must not be mounted",
)
check(
    bool(pod_spec.get("topologySpreadConstraints")),
    "replicas must be spread across nodes",
)

# A scrape annotation on an endpoint that does not exist makes Prometheus log 404s forever.
pod_labels = deployment["spec"]["template"]["metadata"].get("annotations", {})
check(
    "prometheus.io/path" not in pod_labels,
    "no prometheus scrape annotation until a /metrics endpoint exists",
    str(pod_labels.get("prometheus.io/path")),
)

# Secrets must come from a Secret, never from a ConfigMap or an inline value.
check(
    any("secretRef" in source for source in container.get("envFrom", [])),
    "credentials must be sourced from a Secret",
)
configmap = docs["configmap.yaml"][0]
for key, value in configmap.get("data", {}).items():
    check(
        not any(word in key.upper() for word in ("KEY", "SECRET", "PASSWORD", "TOKEN", "CREDENTIAL")),
        f"ConfigMap must not hold a credential, found {key}",
    )

# The template must not carry a real value.
secret = docs["secret.example.yaml"][0]
for key, value in secret.get("stringData", {}).items():
    check(
        value.strip() in {"REPLACE_ME"} or value.startswith("tenant_re_8841:REPLACE_ME"),
        f"secret template must not contain a real value for {key}",
        str(value)[:24],
    )

# The deployment must run an immutable, pinned image. A floating tag means the artifact in
# production is whatever was published last, which is not the artifact anything here verifies.
def is_floating(reference):
    """True if the image reference can change without the manifest changing.

    A digest is immutable. A tag is only pinned if it is something other than latest, main or
    master, and a reference with no tag at all resolves to :latest by default.

    The first version of this was `reference.rpartition("@")[0].endswith((":latest", ...))`,
    which returns True for nothing. `rpartition` on a tag-only reference yields ('', '',
    'gcr.io/x/runtime:latest'), so the tag was dropped before the test and the check passed
    for every image including :latest. A guard that cannot fail is not a guard, and the
    negative control is the only reason that was caught rather than shipped.
    """
    if "@sha256:" in reference:
        return False
    last_segment = reference.rsplit("/", 1)[-1]
    if ":" not in last_segment:
        return True  # no tag means :latest
    return last_segment.rsplit(":", 1)[1] in {"latest", "main", "master"}


image = container.get("image", "")
check(bool(image), "the runtime container must declare an image")
check(
    not is_floating(image),
    "the deployment must reference a pinned image tag or digest, not a floating tag",
    image,
)
# The pod's runAsUser must match the uid the image creates. software_factory/Dockerfile makes
# 10001 and scripts/verify-image.sh asserts the container reports it; a mismatch here means the
# pod crashes on start, which is cheap to catch in a manifest and expensive in a rollout.
check(
    pod_security.get("runAsUser") == 10001,
    "runAsUser must match the uid 10001 the image creates",
    str(pod_security.get("runAsUser")),
)

# cert-manager was asked for a certificate; without a tls block nothing binds it.
ingress = docs["ingress.yaml"][0]
check(
    bool(ingress["spec"].get("tls")),
    "ingress must bind a TLS secret to the cert-manager issuer",
)
tls_hosts = {h for entry in ingress["spec"].get("tls", []) for h in entry.get("hosts", [])}
rule_hosts = {rule.get("host") for rule in ingress["spec"]["rules"]}
check(
    bool(tls_hosts & rule_hosts),
    "the TLS host must match a rule host",
    f"tls={tls_hosts} rules={rule_hosts}",
)

# NetworkPolicy must default deny rather than default allow.
netpol = docs["networkpolicy.yaml"][0]
check("Ingress" in netpol["spec"]["policyTypes"], "NetworkPolicy must cover ingress")
check("Egress" in netpol["spec"]["policyTypes"], "NetworkPolicy must cover egress")

# ── NC-5: what the egress rules actually permit ───────────────────────────────────────────
#
# The checks above assert that Egress is in policyTypes. That is the defect NC-5 lived in:
# this file declared egress coverage and asserted nothing about the destinations, so
# `cidr: 0.0.0.0/0` passed all 51 checks and shipped through every release. A policy that
# covers egress while permitting every host is not a restriction, and the comment above the
# rule -- "replace with a CIDR allowlist before production" -- is documentation of an
# intention, not a control.
#
# Parsed structurally rather than grepped, so a wildcard mentioned in a comment cannot be
# confused for a rule, and a rule expressed in a way the author did not anticipate still
# gets counted.
WILDCARDS = {"0.0.0.0/0", "::/0"}
for doc in docs["networkpolicy.yaml"]:
    for rule in doc.get("spec", {}).get("egress", []) or []:
        for peer in rule.get("to", []) or []:
            block = peer.get("ipBlock")
            if not block:
                continue
            cidr = str(block.get("cidr", "")).strip()
            check(
                cidr not in WILDCARDS,
                "egress must not allow the whole internet; "
                "an allow-all rule lets a compromised process exfiltrate tenant data",
                cidr,
            )
            # A short prefix is the same defect with a narrower netmask: /8 reaches every
            # private network in range, which in many clusters includes the control plane.
            if "/" in cidr:
                try:
                    prefix = int(cidr.rsplit("/", 1)[1])
                except ValueError:
                    prefix = None
                if prefix is not None:
                    check(
                        prefix >= 24,
                        "egress CIDR prefix must be /24 or longer to identify a host, not a network",
                        cidr,
                    )

# The runtime resolves generativelanguage.googleapis.com on every model call. Egress with no
# DNS rule denies all of them, so the absence is a total outage that looks like a security
# fix. Asserted by locating the rule that targets the DNS pods, not by looking for the number
# 53 anywhere in the file -- which this manifest's own comments also contain.
dns_rule = next(
    (
        rule
        for rule in netpol["spec"].get("egress", []) or []
        if any(
            (peer.get("podSelector") or {}).get("matchLabels", {}).get("k8s-app") == "kube-dns"
            for peer in rule.get("to", []) or []
        )
    ),
    None,
)
check(dns_rule is not None, "NetworkPolicy must permit DNS egress to kube-dns")
if dns_rule is not None:
    dns_ports = {str(p.get("port")) for p in dns_rule.get("ports", []) or []}
    check(
        "53" in dns_ports,
        "the DNS egress rule must permit port 53",
        str(sorted(dns_ports)),
    )

# Ingress must be scoped to a namespace, or any pod in any namespace can reach the tenant
# ingestion endpoint and a compromised sidecar elsewhere becomes an isolation bypass.
for rule in netpol["spec"].get("ingress", []) or []:
    for peer in rule.get("from", []) or []:
        check(
            bool(peer.get("namespaceSelector")),
            "ingress peers must be namespace-scoped; an unscoped peer reaches the runtime "
            "from anywhere in the cluster",
            str(sorted(peer)),
        )

# Every referenced namespace must be the one this set declares.
for name in ("deployment.yaml", "hpa.yaml", "ingress.yaml", "configmap.yaml", "networkpolicy.yaml", "secret.example.yaml"):
    for doc in docs[name]:
        check(
            doc.get("metadata", {}).get("namespace") == "factory-production",
            f"{name} must target the declared namespace",
            str(doc.get("metadata", {}).get("namespace")),
        )

# The HPA must not be able to scale to zero, which would make the service unavailable.
hpa = docs["hpa.yaml"][0]
check(hpa["spec"]["minReplicas"] >= 2, "minReplicas must keep a second pod available during a rollout")
check(
    hpa["spec"]["maxReplicas"] > hpa["spec"]["minReplicas"],
    "maxReplicas must exceed minReplicas or the HPA is inert",
)

if failures:
    print(f"FAILED {len(failures)} of {checks} checks:\n", file=sys.stderr)
    for failure in failures:
        print(f"  - {failure}", file=sys.stderr)
    sys.exit(1)

print(f"manifests: {checks}/{checks} checks passed")
