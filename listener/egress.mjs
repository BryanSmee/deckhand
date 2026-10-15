// What a sandbox may reach on the network. Sandboxes sit on an internal Docker network with
// no route out; the egress proxy (../proxy/proxy.mjs) is their only way out, and asks the
// listener, for each connection, whether that sandbox may reach that host. The answer comes
// from here: the mandatory hosts, the operator's ALLOWED_HOSTS, what the operator grants the
// repo (grants.mjs) and the repo's own `hosts` (repo-config.mjs), these only when the grant
// says allow_repo_hosts. Security model: ../docs/security.md.

// "name", "*.domain" (any subdomain, not the domain itself) or "*" (anything).
export const HOST_PATTERN = /^(\*|(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)*)$/;

export function hostProblem(name) {
  return typeof name === "string" && HOST_PATTERN.test(name.toLowerCase())
    ? null
    : "expected a host name, *.domain or *";
}

function hostOf(url) {
  return new URL(url).hostname.toLowerCase();
}

// What Claude Code and GitHub need. Claude Code (with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
// and a CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY credential) only calls api.anthropic.com,
// WebFetch's domain check included: no OAuth refresh, telemetry or update host. git and gh
// use the GitHub hosts the listener is configured with; raw files and release downloads come
// from *.githubusercontent.com. The listener (the broker) is reached directly, on the
// sandboxes' network.
export function mandatoryHosts(config) {
  return [
    "api.anthropic.com",
    ...new Set([hostOf(config.githubUrl), hostOf(config.githubApi)]),
    "*.githubusercontent.com",
  ];
}

// Too broad for a repo to ask for itself: "*" and a whole top-level domain ("*.com"). Only
// the operator can open those (ALLOWED_HOSTS, the grants file).
export function repoHostProblem(name) {
  return name === "*" || /^\*\.[^.]+$/.test(name)
    ? "a repository can't open that much: only the operator can (ALLOWED_HOSTS, the grants file)"
    : null;
}

// What the operator allows a repo without its config: mandatory, ALLOWED_HOSTS, its grant.
function operatorHosts(config, grant) {
  return [...mandatoryHosts(config), ...config.hosts, ...grant.hosts].map((h) => h.toLowerCase());
}

// Whether `pattern` adds nothing to `patterns`: every host it matches, they match too.
function covered(pattern, patterns) {
  if (patterns.includes("*") || patterns.includes(pattern)) return true;
  if (pattern === "*") return false;
  // "*.a.example.com" is within "*.example.com": a subdomain of a.example.com is one of it.
  if (pattern.startsWith("*.")) return matchHost(pattern.slice(2), patterns) === "wildcard";
  return matchHost(pattern, patterns) !== null;
}

// The repo's own hosts that would widen what the operator allows it, when its grant doesn't
// say allow_repo_hosts: those stop its runs (one line each, for the reply). Hosts the
// operator already allows are fine: listing them narrows nothing and widens nothing.
export function refusedRepoHosts(config, grant, settings) {
  if (grant.allowRepoHosts) return [];
  const allowed = operatorHosts(config, grant);
  return settings.hosts
    .filter((host) => !covered(host, allowed))
    .map((host) => `hosts: \`${host}\`: the operator doesn't let this repository add hosts`);
}

// The hosts one run may reach, mandatory ones first. The repo's own only with its grant's
// allow_repo_hosts (refusedRepoHosts stops the run before, this is in case it didn't).
export function runHosts(config, grant, settings) {
  const own = grant.allowRepoHosts ? settings.hosts : [];
  const all = [...operatorHosts(config, grant), ...own];
  return [...new Set(all.map((h) => h.toLowerCase()))];
}

// How `host` matches `patterns`: "exact", "wildcard", "any" (only through "*"), or null.
// The proxy lets private addresses through only for a named host or domain, never for "*".
export function matchHost(host, patterns) {
  const name = String(host).toLowerCase().replace(/\.$/, "");
  if (!name) return null;
  if (patterns.includes(name)) return "exact";
  if (patterns.some((p) => p.startsWith("*.") && name.endsWith(p.slice(1)))) return "wildcard";
  return patterns.includes("*") ? "any" : null;
}

// The proxy settings a sandbox gets. Both cases, as tools disagree (curl only reads the
// lowercase http_proxy); NODE_USE_ENV_PROXY because Node's fetch ignores them otherwise.
export function proxyEnv(config) {
  const direct = new Set(["localhost", "127.0.0.1", "::1", hostOf(config.brokerUrl)]);
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
