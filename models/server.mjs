// Deckhand's models service (#504, docs/services.md): the only one holding the operator's agent
// credentials (Claude, OpenAI, Google: keys, a gateway's token, the plans' logins). Sandboxes'
// agents call their API through it, by the egress proxy, with their run's agent token in place
// of the credential (upstream.mjs); it puts the credential in and streams the answer back. Two
// copies may run side by side on one store: a login's refresh is done once for both
// (logins.mjs), and either one takes any call.
//
// Settings, from the environment (and config.yaml, as the listener reads them: the agents'
// base URLs, which credential runs take):
//   PORT              8080
//   the credentials   CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
//                     OPENAI_API_KEY, CODEX_AUTH_FILE, GEMINI_API_KEY, AGY_AUTH_FILE,
//                     OPENROUTER_API_KEY; the plans' files in DATA_DIR/credentials too
//                     (codex-auth.json, agy-auth.json), read only
//   STORE_URL         its store (lib/store.mjs): file:///data/store, or Redis for two copies on
//                     several nodes (REDIS_PASSWORD)
//   KEY_DIR           where the key the plans' logins are sealed with is (models.key, made on
//                     first start): /keys, its own volume or Secret, never the store
//   SERVICE_NETWORKS  with Docker: each caller's network, service=subnet (proxy, orchestrator);
//                     `none` on Kubernetes, whose NetworkPolicies do that
//   SERVICE_KEYS_DIR  the broker's public keys, which service tokens are checked with
//   BROKER_SERVICE_URL, RUNNER_URL, SERVICE_ACCOUNT_TOKEN_FILE: as the listener's
//   DRAIN_SECONDS     how long a stopping copy lets its calls finish: 600, an agent call's length
import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createBrokerCaller } from "../lib/broker-client.mjs";
import { drainOnSigterm } from "../lib/drain.mjs";
import { createLogger } from "../lib/log.mjs";
import { startMetrics } from "../lib/metrics.mjs";
import { networkCallers } from "../lib/service-token.mjs";
import { openStore } from "../lib/store.mjs";
import { keyFolder } from "../lib/tokens.mjs";
import { AGENT_SECRETS } from "../listener/agents/index.mjs";
import { NAMED, planWarning } from "../listener/agents/credentials.mjs";
import { createBrokerService } from "../listener/broker-service.mjs";
import {
  ConfigError,
  loadConfig,
  readConfigFile,
  CREDENTIAL_FILES,
  withCredentialFiles,
} from "../listener/config.mjs";
import { createRunnerClient } from "../runner/client.mjs";
import { createAnthropicProxy } from "./anthropic.mjs";
import { createAntigravityLogin } from "./antigravity-login.mjs";
import { CHATGPT_URL, createChatgptLogin } from "./chatgpt.mjs";
import { CLOUDCODE_HOST, createGoogleRelay } from "./google.mjs";
import { createModelsServer } from "./http.mjs";
import { fingerprintSalt, loginKey, loginSeal } from "./logins.mjs";
import { createOpenAiProxy } from "./openai.mjs";
import { declareMetrics } from "./metrics.mjs";
import { createRuns } from "./runs.mjs";
import { antigravityPoll, claudePoll, codexPoll, createUsage } from "./usage.mjs";

// An agent call streams for up to 10 minutes (lib/upstream.mjs IDLE_MS): a stopping copy lets
// those in flight finish.
export const DRAIN_MS = 600_000;

// DRAIN_SECONDS → milliseconds.
export function drainMs(text) {
  if (text === undefined || text === "") return DRAIN_MS;
  if (!/^\d+$/.test(text)) throw new Error(`DRAIN_SECONDS: expected seconds, got ${text}`);
  return Number(text) * 1000;
}

// The runner as the models service calls it (the Antigravity login's refresh): the runner
// client names the service it calls as ("models"), the token is the one for the runner's
// audience. `caller`: lib/broker-client.mjs's, with "runner" among its audiences.
export function runnerOf({ urls, caller, fetch, log = () => {} }) {
  return createRunnerClient({
    urls,
    token: () => caller.header("runner"),
    epoch: () => null,
    ...(fetch && { fetch }),
    log,
  });
}

// What the models service can't read of its credentials folder and the plans' files, said at
// start: it reads them as uid 1000, where the listener before it read and rewrote them as root
// (owner-only), and a folder it can't list hides the logins in it (withCredentialFiles()).
// → lines for the log, [] when all is readable.
export function unreadableCredentials(env, { access = accessSync } = {}) {
  const dir = join(env.DATA_DIR || "/data", "credentials");
  const problems = [];
  const check = (path, mode, what) => {
    try {
      access(path, mode);
    } catch (error) {
      if (error.code === "ENOENT") return;
      problems.push(
        `Models: ${what} ${path} can't be read (${error.code}): it runs as uid 1000, give it the credentials folder and its files (chown -R 1000, docs/setup.md#the-models-service)`,
      );
    }
  };
  check(dir, constants.R_OK | constants.X_OK, "the credentials folder");
  // Its files can't be read either then: said once.
  if (problems.length) return problems;
  for (const name of Object.keys(CREDENTIAL_FILES)) {
    if (env[name]) check(env[name], constants.R_OK, `${name},`);
  }
  for (const file of Object.values(CREDENTIAL_FILES)) {
    const path = join(dir, file);
    if (!Object.keys(CREDENTIAL_FILES).some((name) => env[name] === path)) {
      check(path, constants.R_OK, "the login");
    }
  }
  return problems;
}

// The credentials' values in `env`, to redact: not the plans' login variables, which hold a
// file's path (the credentials folder's by default, withCredentialFiles()), no secret: a reply
// naming /data/credentials would be garbled. The logins' tokens are their endpoints' secrets().
export const credentialValues = (env) =>
  AGENT_SECRETS.filter((name) => !Object.hasOwn(CREDENTIAL_FILES, name))
    .map((name) => env[name])
    .filter(Boolean);

// The credentials `env` holds, by name (AGENT_SECRETS): what the listener is told it has.
export const credentialNames = (env) => AGENT_SECRETS.filter((name) => env[name]);

// The service's parts, what the tests start too. `env`: the credentials (withCredentialFiles()'s);
// `config`: loadConfig()'s; `store`, `seal`: where the plans' logins are kept, sealed
// (logins.mjs); `keys`: the broker's public keys ({ get(kid) }), for service tokens; `broker`:
// the broker service as listener/broker-service.mjs calls it (its run keys) with `caller`, its
// lib/broker-client.mjs caller; `refresh`: the runner's login refresh (runner/client.mjs
// refreshLogin()), null without one; `registry`: its metrics' (lib/metrics.mjs), none in most
// tests. → { server, runs, endpoints, ready() }.
export function createModels({
  env,
  config,
  store,
  seal,
  keys,
  broker,
  caller,
  refresh = null,
  bound,
  holder = randomBytes(6).toString("hex"),
  // The fingerprints' salt (logins.mjs fingerprintSalt()); none: one of this copy's own.
  salt,
  now = Date.now,
  // The plans' usage calls' (usage.mjs), Anthropic's, ChatGPT's and Google's.
  fetch = globalThis.fetch,
  registry = null,
  log = () => {},
}) {
  // Its calls, tokens, plans' usage and logins' refreshes (metrics.mjs).
  const metrics = declareMetrics(registry, { readUsage: () => usage.read(), now });
  const runs = createRuns({
    keys: { get: (kid) => broker.keys().get(kid) },
    unknownKey: broker.unknownKey,
    // The broker's record of the run: whether it still goes, and its provider for a token from
    // before the `agent` claim.
    record: async (id) => {
      const res = await caller.call("GET", `/runs/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`the broker answered ${res.status}`);
      return res.json();
    },
    store,
    now,
    log,
  });

  // The plans' logins, which their endpoints and the usage calls share.
  const chatgptLogin =
    config.openaiCredential === "CODEX_AUTH_FILE"
      ? createChatgptLogin({
          file: env.CODEX_AUTH_FILE,
          store,
          seal,
          holder,
          now,
          refreshed: metrics.refreshed("codex"),
          log,
        })
      : null;
  // Refreshed with `agy` itself, in a container the runner starts (runner/service.mjs
  // loginRefresh()).
  const agyLogin =
    config.agyCredential === "AGY_AUTH_FILE"
      ? createAntigravityLogin({
          file: env.AGY_AUTH_FILE,
          config,
          refresh,
          store,
          seal,
          holder,
          now,
          refreshed: metrics.refreshed("antigravity"),
          log,
        })
      : null;
  // How much of each plan the runs used, for the dashboard (GET /usage): a Claude plan's
  // token, by default or named in FALLBACKS, a ChatGPT plan's or a Google AI plan's login.
  const claudePlan = env[NAMED.plan.variable];
  const usage = createUsage({
    plans: {
      claude:
        claudePlan &&
        claudePoll({ token: claudePlan, upstream: config.anthropicUrl || undefined, fetch }),
      codex:
        chatgptLogin && codexPoll({ login: chatgptLogin, chatgptUrl: CHATGPT_URL, fetch, now }),
      antigravity:
        agyLogin &&
        antigravityPoll({
          login: agyLogin,
          host: `https://${CLOUDCODE_HOST}`,
          fetch,
        }),
    },
    store,
    now,
    log,
  });

  // Their Claude Code's API calls, with the operator's credential that they never see.
  const anthropic = createAnthropicProxy({
    runs,
    name: config.claudeCredential,
    credential: config.claudeCredential && env[config.claudeCredential],
    // For runs on a credential their entry names (`claude@anthropic:key`, FALLBACKS).
    named: Object.fromEntries(
      config.credentials["claude@anthropic"].set.map((c) => [c, env[NAMED[c].variable]]),
    ),
    upstream: config.anthropicUrl,
    usage,
    metrics,
    // claude@openrouter, for runs that fall back to it (FALLBACKS).
    providers: {
      openrouter: {
        name: "OPENROUTER_API_KEY",
        credential: env.OPENROUTER_API_KEY,
        upstream: config.openrouterUrl,
      },
    },
    log,
  });
  // Their Codex's, likewise: with a ChatGPT plan's login, this service holds and refreshes it.
  const openai = createOpenAiProxy({
    runs,
    credential: config.openaiCredential === "OPENAI_API_KEY" ? env.OPENAI_API_KEY : null,
    login: chatgptLogin,
    upstream: config.openaiUrl,
    usage,
    metrics,
    log,
  });
  // Their Antigravity CLI's: a Gemini API key, or a Google AI plan's login (relayed by the
  // egress proxy).
  const google = createGoogleRelay({
    runs,
    credential: config.agyCredential === "GEMINI_API_KEY" ? env.GEMINI_API_KEY : null,
    login: agyLogin,
    upstream: config.geminiUrl,
    metrics,
    log,
  });

  let draining = false;
  const server = createModelsServer({
    endpoints: { anthropic, openai, google },
    runs,
    usage,
    store,
    credentials: credentialNames(env),
    ...(salt && { salt }),
    // What runs' output is redacted of, by the orchestrator, from their fingerprints alone.
    secrets: () => [...credentialValues(env), ...openai.secrets(), ...google.secrets()],
    keys,
    bound,
    draining: () => draining,
    waiting: () => !(broker.ready?.() ?? true),
    now,
    log,
  });
  server.startDraining = () => (draining = true);

  // Read (and refreshed if due) now, so a missing or spent login shows before a run needs it.
  function ready() {
    chatgptLogin
      ?.headers()
      .then(() => log(`Codex: a ChatGPT plan's login, from ${env.CODEX_AUTH_FILE}`))
      .catch((error) => log(`Codex: ${error.message}`));
    agyLogin
      ?.headers()
      .then(() => log(`Antigravity CLI: a Google AI plan's login, from ${env.AGY_AUTH_FILE}`))
      .catch((error) => log(`Antigravity CLI: ${error.message}`));
  }

  return { server, runs, usage, endpoints: { anthropic, openai, google }, ready };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // With the plans' logins found in the credentials folder (/data/credentials) when their
  // variables are unset.
  const env = withCredentialFiles(process.env);
  // Its lines redact the agents' credentials too, and the plans' refreshed logins once known.
  let logins = () => [];
  const log = createLogger({
    service: "models",
    secrets: () => [...credentialValues(env), ...logins()],
  });
  let started;
  try {
    const config = loadConfig(env, readConfigFile(env), { service: "models" });
    // Kubernetes' NetworkPolicies and the pods' own service accounts tell callers apart there
    // (#396): SERVICE_NETWORKS=none says so. Anywhere else, it takes no call without it.
    const bound = env.SERVICE_NETWORKS === "none" ? null : networkCallers(env.SERVICE_NETWORKS);
    const caller = createBrokerCaller({
      url: config.brokerServiceUrl,
      service: "models",
      audiences: ["broker", "runner"],
      podTokenFile: config.serviceAccountTokenFile,
      log,
    });
    const broker = createBrokerService({ caller, log });
    const keyDir = env.KEY_DIR || "/keys";
    mkdirSync(keyDir, { recursive: true });
    const key = loginKey(keyDir);
    const seal = loginSeal(key);
    const salt = fingerprintSalt(key);
    // The credentials never go in the store: a value holding one is refused there.
    const store = openStore(env.STORE_URL || `file://${join(config.dataDir, "store")}`, {
      password: env.REDIS_PASSWORD,
      secrets: () => credentialValues(env),
    });
    const runner = runnerOf({ urls: config.runnerUrl, caller, log });
    // Its metrics (../lib/metrics.mjs), on their own port when METRICS_PORT is set.
    const { registry } = startMetrics({ service: "models", port: config.metricsPort, log });
    const models = createModels({
      env,
      config,
      store,
      seal,
      salt,
      keys: keyFolder(env.SERVICE_KEYS_DIR || "/service-keys"),
      broker,
      caller,
      refresh: runner.refreshLogin,
      bound,
      holder: `${hostname()}-${process.pid}`,
      registry,
      log,
    });
    started = { ...models, config, broker, caller, store, graceMs: drainMs(env.DRAIN_SECONDS) };
  } catch (error) {
    if (
      !(error instanceof ConfigError) &&
      !/SERVICE_NETWORKS|DRAIN_SECONDS|key/.test(error.message)
    )
      throw error;
    log.error(`Models: ${error.message}`);
    process.exit(1);
  }
  const { server, config, broker, caller, store, graceMs, ready, endpoints } = started;
  logins = () => [...endpoints.openai.secrets(), ...endpoints.google.secrets()];
  const port = Number(env.PORT ?? 8080);
  server.listen(port, () => log(`Models on :${server.address().port}`));
  for (const name of [config.claudeCredential, config.openaiCredential, config.agyCredential]) {
    const plan = planWarning(name);
    if (plan) log(plan);
  }
  // The broker's keys and this service's tokens, asked for until it answers: a call meanwhile
  // waits for them (lib/broker-client.mjs).
  caller.start();
  broker.start().catch((error) => log(`Broker: ${error.stack ?? error}`));
  for (const line of unreadableCredentials(env)) log(line);
  ready();
  // A rolling update starts the next copy first: this one, out of rotation (/ready), lets the
  // agents' calls in flight finish (10 minutes at most), then exits.
  drainOnSigterm([server], {
    graceMs,
    log,
    before: async () => server.startDraining(),
  });
  process.once("exit", () => {
    broker.stop();
    store.close();
  });
}
