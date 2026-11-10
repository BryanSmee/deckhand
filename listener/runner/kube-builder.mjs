// Whether the BuildKit daemon kube-images.mjs drives is isolated by the services' namespace's
// NetworkPolicies, checked before every build (kube-images.mjs builderIsolation()).
import { excludesSandboxes, selects } from "./kubernetes.mjs";

// Why the services' namespace's NetworkPolicies (`policies`) don't isolate the BuildKit
// daemon's pods (`labels`), or null when they do: one picks them for Egress and one for
// Ingress, and none of those that pick them lets them out but to the namespace's pods (the
// egress proxy) and to DNS (UDP or TCP port 53, no range), or in but from the namespace's pods
// (the runner's), never from another namespace. Without that, a Dockerfile's RUN steps could
// skip the proxy, or anything (a sandbox among them) could drive the daemon, which asks for no
// credentials. Fail closed.
// With the sandboxes in that namespace too (`sandboxesApart` false), an ingress peer has to
// rule them out, as their own policy lets them reach any pod that isn't one; apart, none runs
// there.
export function builderIsolationProblem(policies, labels, { sandboxesApart = false } = {}) {
  const picking = policies.filter((p) => selects(p.spec?.podSelector, labels));
  const types = (p) => p.spec.policyTypes ?? (p.spec.egress ? ["Ingress", "Egress"] : ["Ingress"]);
  for (const type of ["Egress", "Ingress"]) {
    if (!picking.some((p) => types(p).includes(type))) {
      return `no NetworkPolicy picks the BuildKit daemon's pods for ${type}`;
    }
  }
  const dns = (rule) =>
    rule.ports?.length &&
    rule.ports.every(
      (port) =>
        String(port.port) === "53" &&
        port.endPort === undefined &&
        ["UDP", "TCP", undefined].includes(port.protocol),
    );
  for (const p of picking) {
    const name = `the NetworkPolicy ${p.metadata?.name}`;
    for (const rule of p.spec.egress ?? []) {
      // DNS anywhere, written without `to`, as policies often are.
      if (!rule.to?.length && dns(rule)) continue;
      if (!rule.to?.length) return `${name} lets the BuildKit daemon reach anything`;
      const wide = rule.to.some(
        (peer) => peer.ipBlock || peer.namespaceSelector || !peer.podSelector,
      );
      if (wide && !dns(rule)) {
        return `${name} lets the BuildKit daemon reach beyond the namespace's pods (DNS aside)`;
      }
    }
    for (const rule of p.spec.ingress ?? []) {
      const wide =
        !rule.from?.length ||
        rule.from.some((peer) => peer.ipBlock || peer.namespaceSelector || !peer.podSelector);
      if (wide)
        return `${name} lets traffic in to the BuildKit daemon from beyond the namespace's pods`;
      if (
        !sandboxesApart &&
        rule.from.some((peer) => !excludesSandboxes(peer.podSelector, SANDBOX_LABELS))
      ) {
        return `${name} lets sandbox pods reach the BuildKit daemon`;
      }
    }
  }
  return null;
}

// The label keys a sandbox pod carries (kubernetes.mjs start()), and its role: what a peer
// has to rule out to never pick one.
const SANDBOX_LABELS = { "deckhand.owner": "", "deckhand.run": "", "deckhand.role": "sandbox" };
