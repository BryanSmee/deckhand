// Deckhand's policy service (#501, docs/services.md): the operator's and the repositories' Rego
// policies, evaluated by long-lived `opa` servers (engine.mjs) for the services that decide. It
// has no network but its callers' (no way out), holds no secret and keeps no state: any copy
// answers any decision, and a rolling update starts the next copy before this one drains.
//
// Every call carries a service token (../lib/service-token.mjs) the broker signed, checked
// offline with its public keys (SERVICE_KEYS_DIR), and ROUTES says which callers may call each
// endpoint. /health and /ready alone answer without one, for the probes and the status page:
// they say when it started and its version (../lib/health.mjs), nothing else.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { drainable, drainOnSigterm } from "../lib/drain.mjs";
import { healthAnswer, healthInfo } from "../lib/health.mjs";
import { readJsonBody, Refused, send } from "../lib/http.mjs";
import { networkCallers, serviceGuard } from "../lib/service-token.mjs";
import { keyFolder } from "../lib/tokens.mjs";
import { readSettings, readSettingsFile, settingSource } from "../lib/settings.mjs";
import { isMap, parseYaml } from "../lib/yaml.mjs";
import { createEngine } from "./engine.mjs";
import { createLogger, withRequest } from "../lib/log.mjs";
import { metricsPort, startMetrics } from "../lib/metrics.mjs";

// The services that decide (lib/services.mjs CALLS): the orchestrator (merges, reviews, fixes,
// linked branches, reviewers, the config check, `/mode policy` and the Policies tab), the github
// service (a run's writes) and the broker. Until they leave the listener, it calls as the
// orchestrator. The runner asks the grants a repository gets (#498), the operator's alone: a
// decision, not the capabilities nor a repository's files' check.
const DECIDERS = ["orchestrator", "github", "broker"];
export const ROUTES = {
  "GET /policies": [...DECIDERS, "runner"],
  "POST /evaluate": [...DECIDERS, "runner"],
  "POST /capabilities": DECIDERS,
  "POST /check": DECIDERS,
};

// A request's body at most: a decision's input and a repository's policy files.
export const MAX_BODY = 4 << 20;

// How long a stopping copy lets its decisions finish: each one takes 2 s at most once its set
// runs, a few more to start a set's opa.
export const DRAIN_MS = 25_000;

// The grants folder's default, as the listener's (listener/config.mjs GRANTS_DIR).
export const GRANTS_DIR = "/etc/deckhand/grants";

// The grants folder, found as the listener finds it, with its settings code (lib/settings.mjs):
// GRANTS_DIR in the environment, else `grants_dir` in the settings file (CONFIG_FILE, else
// /etc/deckhand/config.yaml, the server folder both mount), else GRANTS_DIR's default. The
// file's other keys are the listener's, which it checks; a file that can't be read or parsed
// throws, as it stops the listener. Should both still read different files, the listener refuses
// every decision (listener/policies.mjs), so the operator's rules are never dropped unseen.
export function grantsDirOf(env, read = undefined) {
  const specs = { GRANTS_DIR: { default: GRANTS_DIR } };
  const file = readSettingsFile(env, {
    path: "/etc/deckhand/config.yaml",
    ...(read && { read }),
    parse: (text, path) => {
      let raw;
      try {
        raw = parseYaml(text);
      } catch (error) {
        throw new Error(`${path}: ${error.message}`);
      }
      const value = isMap(raw) ? raw.grants_dir : undefined;
      return { path, settings: typeof value === "string" ? { GRANTS_DIR: value } : {} };
    },
  });
  return readSettings(env, settingSource(env, file, specs), specs).GRANTS_DIR;
}

// What the runner may ask (#498): a repository's grants, of the operator's layer alone. It
// checks specs and builds against them, and has no business with a run's writes or
// a repository's own files. Throws a Refused otherwise.
export function runnerAsks(body) {
  if (body.decision !== "grant" || body.repo != null || body.repoAllow) {
    throw new Refused(403, "the runner asks a repository's grants only, of the operator's layer");
  }
}

// `engine`: createEngine()'s; `guard(req)` → the caller, or a Refused (serviceGuard()).
// `health`: what GET /health says (../lib/health.mjs).
export function createPolicyService({ engine, guard, log = () => {}, health = healthInfo() }) {
  let draining = false;
  const server = drainable(
    createServer(
      withRequest(async (req, res) => {
        if (req.url === "/health") return send(res, 200, healthAnswer(health));
        if (req.url === "/ready") {
          res.writeHead(draining ? 503 : 200, { "content-type": "text/plain" });
          return res.end(draining ? "draining\n" : "ok\n");
        }
        try {
          const caller = guard(req);
          const path = req.url.split("?")[0];
          if (req.method === "GET" && path === "/policies")
            return send(res, 200, engine.policies());
          const body = await readJsonBody(req, MAX_BODY);
          if (!body || typeof body !== "object") throw new Refused(400, "expected an object");
          if (path === "/evaluate") {
            if (caller === "runner") runnerAsks(body);
            return send(res, 200, await engine.evaluate(body));
          }
          // What a run gets as it starts (#495): every mode of a config page in one call.
          if (path === "/capabilities") {
            return send(res, 200, await engine.evaluateCapabilities(body));
          }
          if (path === "/check") return send(res, 200, await engine.compile(body));
          throw new Refused(404, "no such endpoint");
        } catch (error) {
          if (error instanceof Refused) return send(res, error.status, { error: error.message });
          (log.error ?? log)(`${req.method} ${req.url}: ${error.message ?? error}`);
          if (!res.headersSent) send(res, 500, { error: "the policy service failed" });
        }
      }),
    ),
  );
  // /ready says 503 from then on: a readiness probe takes the copy out of rotation.
  server.draining = () => {
    draining = true;
  };
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const log = createLogger({ service: "policy" });
  const env = process.env;
  const port = Number(env.PORT || 8181);
  // Its metrics (../lib/metrics.mjs), on their own port when METRICS_PORT is set.
  try {
    startMetrics({ service: "policy", port: metricsPort(env.METRICS_PORT), log });
  } catch (error) {
    log.error(`Policy service: ${error.message}`);
    process.exit(1);
  }
  const keysDir = env.SERVICE_KEYS_DIR || "/keys";
  const grantsDir = grantsDirOf(env);
  const engine = createEngine({ grantsDir, log });
  // Where the network tells its callers apart (one network per caller, SERVICE_NETWORKS); none
  // set, null: with Docker Compose its one network is the listener's, the only caller there.
  const bound = env.SERVICE_NETWORKS ? networkCallers(env.SERVICE_NETWORKS) : null;
  const guard = serviceGuard({
    service: "policy",
    keys: keyFolder(keysDir),
    routes: ROUTES,
    bound,
  });
  const server = createPolicyService({ engine, guard, log });
  server.listen(port, () =>
    log(`Policy service on :${port}, grants in ${grantsDir}, keys in ${keysDir}`),
  );
  drainOnSigterm([server], {
    graceMs: DRAIN_MS,
    log,
    before: async () => server.draining(),
    exit: async (code) => {
      await engine.stop();
      process.exit(code);
    },
  });
}
