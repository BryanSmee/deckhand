// What a sandbox may reach on the network. Sandboxes sit on an internal Docker network with
// no route out; the egress proxy (../proxy/proxy.mjs) is their only way out, and asks the
// listener, for each connection, whether that sandbox may reach that host. The answer comes
// from here: the mandatory hosts, the operator's ALLOWED_HOSTS, what the operator grants the
// repo (grants.mjs) and the repo's own `hosts` (repo-config.mjs), these only when the grant
// says allow_repo_hosts. Security model: ../docs/security.md.
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

// What the agent (its `hosts`, agents/) and GitHub need. git and gh use the GitHub hosts the
// listener is configured with; raw files and release downloads come from
// *.githubusercontent.com. The listener (the broker) is reached directly, on the sandboxes'
// network.
export function mandatoryHosts(config, agent = agentFor()) {
  return [
    ...agent.hosts,
    ...new Set([hostOf(config.githubUrl), hostOf(config.githubApi)]),
    "*.githubusercontent.com",
  ];
}

// Suffixes under which anyone can have a name: a wildcard over one opens many owners' hosts
// (`*.github.io`), or any address (`*.nip.io` resolves `10-0-0-1.nip.io` to 10.0.0.1). Not
// the whole public suffix list: the common ones, top-level domains being refused anyway.
const PUBLIC_SUFFIXES = new Set([
  ...["co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au"],
  ...["co.jp", "ne.jp", "or.jp", "co.nz", "co.za", "co.in", "com.br", "com.cn", "com.mx"],
  ...["github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app"],
  ...["herokuapp.com", "appspot.com", "web.app", "firebaseapp.com", "azurewebsites.net"],
  ...["cloudfront.net", "amazonaws.com", "ngrok.io", "ngrok-free.app", "trycloudflare.com"],
  ...["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "duckdns.org"],
]);

// What a repo can't ask for itself, granted or not; only the operator can (ALLOWED_HOSTS,
// the grants folder): "*", a whole top-level domain ("*.com") or public suffix
// ("*.co.uk"), an IP address or a single-label name (`listener`, `localhost`): those name
// what sits next to the sandboxes, not a service on the internet.
export function repoHostProblem(name) {
  const only = "only the operator can (ALLOWED_HOSTS, the grants folder)";
  const suffix = name.replace(/^\*\./, "");
  if (
    name === "*" ||
    (name.startsWith("*.") && (!suffix.includes(".") || PUBLIC_SUFFIXES.has(suffix)))
  ) {
    return `a repository can't open that much: ${only}`;
  }
  // A name's last label is never all digits: "10.0.0.1", or "*.0.1" matching addresses.
  if (/(^|\.)\d+$/.test(name)) return `a repository can't name an address: ${only}`;
  if (!name.includes(".")) return `a repository can't name a host without a domain: ${only}`;
  return null;
}

// What the operator allows a repo without its config: mandatory, ALLOWED_HOSTS, its grant.
export function operatorHosts(config, grant) {
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
export function matchHost(host, patterns) {
  const name = String(host).toLowerCase().replace(/\.$/, "");
  if (!name) return null;
  if (patterns.includes(name)) return "exact";
  if (patterns.some((p) => p.startsWith("*.") && name.endsWith(p.slice(1)))) return "wildcard";
  return patterns.includes("*") ? "any" : null;
}

// The proxy's answer for `host` in a run. Private addresses only for a host or domain the
// operator named (`trusted`: operatorHosts()), never through "*" alone nor for a repo's own
// hosts: whoever pushes to its default branch could point those at the LAN or the listener.
export function egressPolicy(host, hosts, trusted) {
  const allowed = matchHost(host, hosts) !== null;
  const named = matchHost(host, trusted ?? []);
  return { allowed, private: allowed && (named === "exact" || named === "wildcard") };
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
