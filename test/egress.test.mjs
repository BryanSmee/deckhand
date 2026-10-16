import assert from "node:assert/strict";
import { test } from "node:test";
import { claude } from "../listener/agents/claude.mjs";
import { codex } from "../listener/agents/codex.mjs";
import { loadConfig } from "../listener/config.mjs";
import {
  egressPolicy,
  hostProblem,
  mandatoryHosts,
  matchHost,
  operatorHosts,
  proxyEnv,
} from "../listener/egress.mjs";
import { grantFor, grantsFrom } from "../listener/grants.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";

const config = loadConfig({ ALLOWED_USERS: "a" });

// The grants folder's default.yaml and one repo's file, as grantFor() reads them.
const grants = grantsFrom(
  {
    "default.yaml": "hosts: [Registry.npmjs.org]\n",
    "org/api.yaml": 'hosts: ["*.lan.example", pypi.org, registry.npmjs.org]\n',
  },
  config,
);

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

test("a Codex run's hosts: GitHub's and its grant's, neither Anthropic's nor OpenAI's", () => {
  const grant = grantFor(grants, config, "org/web");
  const hosts = operatorHosts(config, grant, codex);
  assert.deepEqual(hosts, [
    "github.com",
    "api.github.com",
    "*.githubusercontent.com",
    "registry.npmjs.org",
  ]);
  for (const host of ["api.anthropic.com", "api.openai.com", "chatgpt.com"]) {
    assert.equal(egressPolicy(host, hosts, hosts).allowed, false, host);
  }
  // Claude Code's keep Anthropic's, for WebFetch's domain check.
  assert.ok(operatorHosts(config, grant, claude).includes("api.anthropic.com"));
  // Without an agent, the operator's: its mandatory hosts are SANDBOX_AGENT's.
  const operator = loadConfig({ ALLOWED_USERS: "a", OPENAI_API_KEY: "k", SANDBOX_AGENT: "codex" });
  assert.ok(!mandatoryHosts(operator).includes("api.anthropic.com"));
});

test("a run's hosts: mandatory, default.yaml's for every repo, the repo's own grant's", () => {
  const mandatory = [
    "api.anthropic.com",
    "github.com",
    "api.github.com",
    "*.githubusercontent.com",
  ];
  assert.deepEqual(operatorHosts(config, grantFor(grants, config, "org/web")), [
    ...mandatory,
    "registry.npmjs.org",
  ]);
  // Once each, default.yaml's first.
  assert.deepEqual(operatorHosts(config, grantFor(grants, config, "Org/API")), [
    ...mandatory,
    "registry.npmjs.org",
    "*.lan.example",
    "pypi.org",
  ]);
});

test("a repo's own hosts are ignored, with a warning naming the grants file", () => {
  const { errors, warnings, settings } = parseRepoConfig('hosts: ["*", evil.net]\n', config);
  assert.deepEqual(errors, []);
  assert.match(
    warnings[0],
    /^hosts: ignored, the operator lists the hosts in grants\/<owner>\/<repo>\.yaml/,
  );
  assert.equal("hosts" in settings, false);
});

test("the operator can name an address or a host without a domain", () => {
  const own = grantsFrom({ "org/api.yaml": 'hosts: [listener, 172.17.0.1, "*"]\n' }, config);
  assert.deepEqual(grantFor(own, config, "org/api").hosts, ["listener", "172.17.0.1", "*"]);
});

test("private addresses only for hosts the operator named, default.yaml's too, not through *", () => {
  const hosts = [...operatorHosts(config, grantFor(grants, config, "org/api")), "*"];
  const answer = (host) => egressPolicy(host, hosts, hosts);
  // default.yaml's, as ALLOWED_HOSTS was.
  assert.deepEqual(answer("registry.npmjs.org"), {
    allowed: true,
    private: true,
    cache: false,
  });
  assert.deepEqual(answer("nas.lan.example"), { allowed: true, private: true, cache: false });
  assert.deepEqual(answer("anything.net"), { allowed: true, private: false, cache: false });
  // A run restored from before repos lost their own hosts: those stay public.
  assert.deepEqual(egressPolicy("repo.dev", ["github.com", "repo.dev"], ["github.com"]), {
    allowed: true,
    private: false,
    cache: false,
  });
  assert.deepEqual(egressPolicy("x.net", ["github.com"], ["github.com"]), {
    allowed: false,
    private: false,
    cache: false,
  });
  // A run saved before `trusted` was: nothing private.
  assert.deepEqual(egressPolicy("github.com", ["github.com"], undefined), {
    allowed: true,
    private: false,
    cache: false,
  });
});

test("cache: only for allowed hosts the run's cached_hosts match", () => {
  const files = {
    "default.yaml": "hosts: [deb.debian.org]\ncached_hosts: [deb.debian.org]\n",
    "org/api.yaml": 'hosts: ["*.example.com"]\ncached_hosts: ["*.example.com", nowhere.net]\n',
  };
  const grant = grantFor(grantsFrom(files, config), config, "org/api");
  assert.deepEqual(grant.cachedHosts, ["deb.debian.org", "*.example.com", "nowhere.net"]);
  const hosts = operatorHosts(config, grant);
  const cache = (host) => egressPolicy(host, hosts, hosts, grant.cachedHosts).cache;
  assert.equal(cache("deb.debian.org"), true);
  assert.equal(cache("dl.example.com"), true);
  assert.equal(cache("github.com"), false);
  // Listed, but not reachable: refused all the same.
  assert.equal(cache("nowhere.net"), false);
  // Never the agent's or GitHub's, whatever cached_hosts says: their traffic carries tokens.
  const everything = ["*"];
  const uncached = mandatoryHosts(config);
  const policy = (host) => egressPolicy(host, hosts, hosts, everything, uncached).cache;
  assert.equal(policy("deb.debian.org"), true);
  assert.equal(policy("github.com"), false);
  assert.equal(policy("api.github.com"), false);
  assert.equal(policy("objects.githubusercontent.com"), false);
  // A run saved before `cached` was: nothing cached.
  assert.equal(egressPolicy("deb.debian.org", hosts, hosts, undefined).cache, false);
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

test("host patterns are checked, in the grants folder", () => {
  for (const ok of ["github.com", "*.example.com", "*", "localhost", "10.0.0.1", "a_b.lan"]) {
    assert.equal(hostProblem(ok), null, ok);
  }
  for (const bad of ["a.*.com", "*example.com", "https://x.com", "x.com/a", "", 3, "a b"]) {
    assert.ok(hostProblem(bad), String(bad));
  }
  assert.throws(
    () => grantsFrom({ "default.yaml": 'hosts: [x.com, "a.*.b"]\n' }, config),
    /default\.yaml: hosts: "a\.\*\.b": expected a host name/,
  );
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

test("limits: built in, under default.yaml's, and checked", () => {
  assert.deepEqual(config.limits, { cpus: "2", memory: "4g", pids: 2048 });
  const set = grantsFrom({ "default.yaml": "limits: { cpus: 0.5, memory: 512M }\n" }, config);
  assert.deepEqual(grantFor(set, config, "org/web").limits, {
    cpus: "0.5",
    memory: "512m",
    pids: 2048,
  });
  assert.throws(
    () => grantsFrom({ "default.yaml": "limits: { cpus: -1 }\n" }, config),
    /default\.yaml: limits\.cpus: expected/,
  );
});
