// What a sandbox may reach on the network. Each sandbox sits on an internal Docker network,
// its own, with no route out; the egress proxy (../proxy/proxy.mjs) is their only way out, and asks the
// listener, for each connection, whether that sandbox may reach that host. The answer comes
// from here: the mandatory hosts and what the operator grants the repo in the grants folder
// (grants.mjs: default.yaml's hosts and its own file's). Security model: ../docs/security.md.
import { agentFor } from "./agents/index.mjs";

// "name", "*.domain" (any subdomain, not the domain itself) or "*" (anything).
const HOST_PATTERN = /^(\*|(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)*)$/;

export function hostProblem(name) {
  return typeof name === "string" && HOST_PATTERN.test(name.toLowerCase())
    ? null
    : "expected a host name, *.domain or *";
}

function hostOf(url) {
  return new URL(url).hostname.toLowerCase();
}

// What the agent (its `hosts`, agents/; by default the operator's) and GitHub need. git and
// gh use the GitHub hosts the listener is configured with; raw files and release downloads
// come from *.githubusercontent.com. The listener (the broker) is reached directly, on the
// run's own network.
export function mandatoryHosts(config, agent = agentFor(config.agent)) {
  return [
    ...agent.hosts,
    ...new Set([hostOf(config.githubUrl), hostOf(config.githubApi)]),
    "*.githubusercontent.com",
  ];
}

// What the operator allows a repo's runs of `agent`: the mandatory hosts and its grant's
// (default.yaml's and its own file's), once each.
export function operatorHosts(config, grant, agent) {
  const all = [...mandatoryHosts(config, agent), ...grant.hosts];
  return [...new Set(all.map((h) => h.toLowerCase()))];
}

// How `host` matches `patterns`: "exact", "wildcard", "any" (only through "*"), or null.
export function matchHost(host, patterns) {
  const name = String(host).toLowerCase().replace(/\.$/, "");
  if (!name) return null;
  if (patterns.includes(name)) return "exact";
  if (patterns.some((p) => p.startsWith("*.") && name.endsWith(p.slice(1)))) return "wildcard";
  return patterns.includes("*") ? "any" : null;
}

// The proxy's answer for `host` in a run. Private addresses only for a host or domain the
// operator named (`trusted`: operatorHosts()), never through "*" alone. A run restored from
// before repos lost their own `hosts` may still list some: those stay public only. `cache`:
// the proxy may keep its plain HTTP answers (the grant's `cached_hosts`, matched like hosts).
export function egressPolicy(host, hosts, trusted, cached) {
  const allowed = matchHost(host, hosts) !== null;
  const named = matchHost(host, trusted ?? []);
  return {
    allowed,
    private: allowed && (named === "exact" || named === "wildcard"),
    cache: allowed && matchHost(host, cached ?? []) !== null,
  };
}

// The proxy settings a sandbox gets. Both cases, as tools disagree (curl only reads the
// lowercase http_proxy); NODE_USE_ENV_PROXY because Node's fetch ignores them otherwise.
// `others`: more hosts on the run's network (its container engine), reached directly.
export function proxyEnv(config, others = []) {
  const direct = new Set(["localhost", "127.0.0.1", "::1", hostOf(config.brokerUrl), ...others]);
  const noProxy = [...direct].join(",");
  return {
    HTTP_PROXY: config.egressProxy,
    HTTPS_PROXY: config.egressProxy,
    http_proxy: config.egressProxy,
    https_proxy: config.egressProxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: "1",
  };
}
