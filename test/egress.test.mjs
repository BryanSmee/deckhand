import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../listener/config.mjs";
import { hostProblem, mandatoryHosts, matchHost, proxyEnv, runHosts } from "../listener/egress.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";

const config = loadConfig({ ALLOWED_USERS: "a", ALLOWED_HOSTS: "Registry.npmjs.org" });

test("mandatory hosts: Anthropic's API and the configured GitHub", () => {
  assert.deepEqual(mandatoryHosts(config), [
    "api.anthropic.com",
    "github.com",
    "api.github.com",
    "*.githubusercontent.com",
  ]);
  const enterprise = loadConfig({
    ALLOWED_USERS: "a",
    GITHUB_URL: "https://git.corp.example",
    GITHUB_API: "https://git.corp.example/api/v3",
  });
  assert.deepEqual(mandatoryHosts(enterprise), [
    "api.anthropic.com",
    "git.corp.example",
    "*.githubusercontent.com",
  ]);
});

test("a run's hosts: mandatory, the operator's, its grant's and its repo's", () => {
  const { settings } = parseRepoConfig('hosts: ["*.example.com", "*"]\n', config);
  assert.deepEqual(runHosts(config, { hosts: ["pypi.org"] }, settings), [
    "api.anthropic.com",
    "github.com",
    "api.github.com",
    "*.githubusercontent.com",
    "registry.npmjs.org",
    "pypi.org",
    "*.example.com",
    "*",
  ]);
});

test("host matching: names, subdomain wildcards, *", () => {
  const hosts = ["github.com", "*.example.com"];
  assert.equal(matchHost("github.com", hosts), "exact");
  assert.equal(matchHost("GitHub.com.", hosts), "exact");
  assert.equal(matchHost("a.example.com", hosts), "wildcard");
  assert.equal(matchHost("a.b.example.com", hosts), "wildcard");
  // The domain itself isn't one of its subdomains.
  assert.equal(matchHost("example.com", hosts), null);
  assert.equal(matchHost("badexample.com", hosts), null);
  assert.equal(matchHost("gist.github.com", hosts), null);
  assert.equal(matchHost("example.com.evil.net", hosts), null);
  assert.equal(matchHost("", hosts), null);
  assert.equal(matchHost("anything.net", [...hosts, "*"]), "any");
  assert.equal(matchHost("a.example.com", [...hosts, "*"]), "wildcard");
});

test("host patterns are checked, in the operator's settings and a repo's config", () => {
  for (const ok of ["github.com", "*.example.com", "*", "localhost", "10.0.0.1", "a_b.lan"]) {
    assert.equal(hostProblem(ok), null, ok);
  }
  for (const bad of ["a.*.com", "*example.com", "https://x.com", "x.com/a", "", 3, "a b"]) {
    assert.ok(hostProblem(bad), String(bad));
  }
  assert.throws(
    () => loadConfig({ ALLOWED_USERS: "a", ALLOWED_HOSTS: "x.com, a.*.b" }),
    ConfigError,
  );
  const { errors } = parseRepoConfig('hosts: ["*.ok.com", "not ok"]\n', config);
  assert.match(errors[0], /hosts: "not ok": expected a host name/);
});

test("proxy settings for every kind of tool, the broker reached directly", () => {
  assert.deepEqual(proxyEnv(config), {
    HTTP_PROXY: "http://egress:3128",
    HTTPS_PROXY: "http://egress:3128",
    http_proxy: "http://egress:3128",
    https_proxy: "http://egress:3128",
    NO_PROXY: "localhost,127.0.0.1,::1,listener",
    no_proxy: "localhost,127.0.0.1,::1,listener",
    NODE_USE_ENV_PROXY: "1",
  });
});

test("limits: defaults, and checked", () => {
  assert.deepEqual(config.limits, { cpus: "2", memory: "4g", pids: 2048 });
  const set = loadConfig({
    ALLOWED_USERS: "a",
    SANDBOX_CPUS: "0.5",
    SANDBOX_MEMORY: "512M",
    SANDBOX_PIDS: "100",
  });
  assert.deepEqual(set.limits, { cpus: "0.5", memory: "512m", pids: 100 });
  assert.throws(() => loadConfig({ ALLOWED_USERS: "a", SANDBOX_CPUS: "-1" }), /SANDBOX_CPUS/);
  assert.throws(() => loadConfig({ ALLOWED_USERS: "a", SANDBOX_PIDS: "1.5" }), /SANDBOX_PIDS/);
});
