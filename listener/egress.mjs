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

// The GitHub hosts the listener is configured with, the web's and the API's (one, on GitHub
// Enterprise Server): what git and gh use. The egress proxy relays them to the listener's GitHub
// gateway (github-gateway.mjs), which holds the token: never a raw tunnel from a sandbox.
export function githubHosts(config) {
  return [...new Set([hostOf(config.githubUrl), hostOf(config.githubApi)])];
}

// The hosts relayed to the GitHub gateway: GitHub's, and its files' (GITHUB_FILES).
export function relayedGithub(config) {
  return [...githubHosts(config), ...GITHUB_FILES];
}

// Where GitHub serves a repository's files, any public one's without a token, a fork's pull
// request's included: its raw files, its LFS files, its pull requests' and commits' diffs.
// Relayed to the GitHub gateway too, which checks what a work run reads there (github-forks.mjs)
// and sends it on anonymously (github-gateway.mjs FILES).
export const GITHUB_FILES = [
  "raw.githubusercontent.com",
  "media.githubusercontent.com",
  "patch-diff.githubusercontent.com",
];

// What the agent (its `hosts`, agents/; by default the operator's) and GitHub need. Raw files
// and release downloads come from *.githubusercontent.com, which carries no token: allowed,
// GITHUB_FILES relayed (relayedGithub()), the others (release assets, avatars) plain hosts.
// The listener (the broker) is reached directly, on the run's own network.
export function mandatoryHosts(config, agent = agentFor(config.agent)) {
  return [...agent.hosts, ...githubHosts(config), "*.githubusercontent.com"];
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
// the proxy may keep its answers (the grant's `cached_hosts`, matched like hosts), never for
// the `uncached` ones (mandatoryHosts(): their traffic carries the run's tokens) whatever
// `cached` says; `decrypt`: and its HTTPS, decrypted to do so, unless `decrypt` is false (a
// container engine, whose builds and containers don't trust Deckhand's CA: plain HTTP only).
// `relayed` (GitHub's, githubHosts(), and the run's agent's, agents/): hosts whose HTTPS the
// proxy decrypts and hands to the listener, which puts a token or the operator's credential in
// place of the run's secret (github-gateway.mjs, google.mjs); never cached. `blocked` (the agent's too): refused whatever the grants say.
export function egressPolicy(
  host,
  hosts,
  trusted,
  cached,
  uncached = [],
  { decrypt = true, relayed = [], blocked = [] } = {},
) {
  if (matchHost(host, blocked) !== null) {
    return { allowed: false, private: false, cache: false, decrypt: false, relay: false };
  }
  const allowed = matchHost(host, hosts) !== null;
  const named = matchHost(host, trusted ?? []);
  const relay = allowed && decrypt && matchHost(host, relayed) === "exact";
  const cache =
    allowed &&
    !relay &&
    matchHost(host, cached ?? []) !== null &&
    matchHost(host, uncached) === null;
  return {
    allowed,
    private: allowed && (named === "exact" || named === "wildcard"),
    cache,
    decrypt: (cache || relay) && decrypt,
    relay,
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

// The egress proxy's CA certificate (../proxy/authority.mjs), which sandboxes trust when they
// reach GitHub (relayed), their grant has cached_hosts or their agent has relayed hosts; null
// when it has none or doesn't answer. Asked at each such run: a new proxy volume is a new CA.
export async function fetchEgressCa(egressProxy) {
  try {
    const res = await fetch(`${egressProxy}/deckhand-ca.crt`, {
      signal: AbortSignal.timeout(5000),
    });
    const pem = res.ok ? await res.text() : "";
    return pem.includes("BEGIN CERTIFICATE") ? pem : null;
  } catch {
    return null;
  }
}
