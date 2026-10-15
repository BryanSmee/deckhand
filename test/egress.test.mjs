import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../listener/config.mjs";
import {
  hostProblem,
  mandatoryHosts,
  matchHost,
  proxyEnv,
  refusedRepoHosts,
  runHosts,
} from "../listener/egress.mjs";
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

test("a run's hosts: mandatory, the operator's, its grant's, its repo's with allow_repo_hosts", () => {
  const { settings } = parseRepoConfig('hosts: ["*.example.com", pypi.org]\n', config);
  const operator = [
    "api.anthropic.com",
    "github.com",
    "api.github.com",
    "*.githubusercontent.com",
    "registry.npmjs.org",
    "pypi.org",
  ];
  const granted = { hosts: ["pypi.org"], allowRepoHosts: true };
  assert.deepEqual(runHosts(config, granted, settings), [...operator, "*.example.com"]);
  assert.deepEqual(refusedRepoHosts(config, granted, settings), []);
  // Without the operator's permission the repo's own hosts never reach the list.
  const plain = { hosts: ["pypi.org"], allowRepoHosts: false };
  assert.deepEqual(runHosts(config, plain, settings), operator);
});

test("without allow_repo_hosts, a repo's hosts that widen egress are refused", () => {
  const hosts = (list) => parseRepoConfig(`hosts: [${list}]\n`, config).settings;
  const grant = { hosts: ["*.example.com", "pypi.org"], allowRepoHosts: false };
  // Already allowed by the operator, mandatory or granted: nothing widens, nothing refused.
  const covered = hosts(
    'registry.npmjs.org, api.github.com, "*.githubusercontent.com", raw.githubusercontent.com, pypi.org, a.example.com, "*.a.example.com", "*.example.com"',
  );
  assert.deepEqual(refusedRepoHosts(config, grant, covered), []);
  // Wider than what the operator allows: each named.
  const wider = hosts('example.com, files.pypi.org, "*.pypi.org", evil.net');
  assert.deepEqual(
    refusedRepoHosts(config, grant, wider).map((r) => r.match(/`(.+)`/)[1]),
    ["example.com", "files.pypi.org", "*.pypi.org", "evil.net"],
  );
  assert.match(refusedRepoHosts(config, grant, wider)[0], /doesn't let this repository add hosts/);
  // An operator who allows "*" allows everything a repo could list.
  const open = loadConfig({ ALLOWED_USERS: "a", ALLOWED_HOSTS: "*" });
  assert.deepEqual(refusedRepoHosts(open, { hosts: [], allowRepoHosts: false }, wider), []);
});

test("a repo can never open every host, granted or not", () => {
  for (const host of ['"*"', '"*.com"', '"*.Dev"']) {
    const { errors, settings } = parseRepoConfig(`hosts: [pypi.org, ${host}]\n`, config);
    assert.match(errors[0], /a repository can't open that much: only the operator can/, host);
    assert.deepEqual(settings.hosts, ["pypi.org"]);
  }
  assert.deepEqual(parseRepoConfig('hosts: ["*.example.com"]\n', config).errors, []);
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
