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
