// The services' health, for the dashboard's status page (GET api/health, #560): the
// orchestrator calls each service's GET /health (../lib/health.mjs), all at once, and says
// which is up, starting (a restart or an update within STARTING_MS) or down, and why. Answers
// are kept CACHE_MS, so that many dashboards open don't each probe every service. What it
// says never holds a service's URL or what it answered beyond its start, version and warnings
// (what it said of its setup at start: its blobs taking Redis's memory, ../lib/blobs.mjs).
export const MAX_WARNINGS = 5;
export const WARNING_LENGTH = 300;
import { SERVICES } from "../lib/services.mjs";

export const TIMEOUT_MS = 2000;
export const CACHE_MS = 10_000;
// Started this recently: "starting", a recent restart or update, rather than "up".
export const STARTING_MS = 5 * 60_000;

// `urls`: service → its URL, its copies comma-separated (a service without one is left out);
// `self`: { name, startedAt, version } of the service asking, which reports itself unprobed.
// `fetch` and `now`: the tests'.
export function createHealth({
  urls,
  self,
  fetch = globalThis.fetch,
  now = Date.now,
  timeoutMs = TIMEOUT_MS,
  cacheMs = CACHE_MS,
  startingMs = STARTING_MS,
}) {
  const probed = SERVICES.filter((name) => name !== self.name && urls[name]);
  let last = null;

  // up or starting, by when it started: an answer without a start (a copy from before #560)
  // is up.
  const stateOf = (startedAt, at) =>
    startedAt !== null && at - startedAt < startingMs ? "starting" : "up";

  // One copy's answer → { startedAt, version }, or throws with the reason it is down.
  async function ask(url) {
    let res;
    try {
      res = await fetch(`${url.replace(/\/$/, "")}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
    } catch (error) {
      throw new Error(reasonOf(error));
    }
    if (res.status < 200 || res.status > 299) {
      res.body?.cancel?.().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error("not JSON");
    }
    if (body?.ok !== true) throw new Error("not ok");
    const warnings = Array.isArray(body.warnings)
      ? body.warnings
          .filter((w) => typeof w === "string" && w)
          .slice(0, MAX_WARNINGS)
          .map((w) => w.slice(0, WARNING_LENGTH))
      : [];
    return {
      startedAt: Number.isFinite(body.startedAt) ? body.startedAt : null,
      version: typeof body.version === "string" ? body.version.slice(0, 64) : null,
      warnings,
    };
  }

  // A service: its copies in turn, the first that answers ok.
  async function probe(name) {
    let reason = "unreachable";
    for (const url of urls[name]
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean)) {
      try {
        const { startedAt, version, warnings } = await ask(url);
        const checkedAt = now();
        return {
          name,
          state: stateOf(startedAt, checkedAt),
          startedAt,
          version,
          checkedAt,
          ...(warnings.length && { warnings }),
        };
      } catch (error) {
        reason = error.message;
      }
    }
    return { name, state: "down", startedAt: null, version: null, checkedAt: now(), reason };
  }

  async function run() {
    const found = new Map((await Promise.all(probed.map(probe))).map((s) => [s.name, s]));
    const checkedAt = now();
    found.set(self.name, {
      name: self.name,
      state: stateOf(self.startedAt, checkedAt),
      startedAt: self.startedAt,
      version: self.version,
      checkedAt,
    });
    // In the services' order (../lib/services.mjs), whichever answered first.
    return { checkedAt, services: SERVICES.filter((n) => found.has(n)).map((n) => found.get(n)) };
  }

  // { checkedAt, services: [{ name, state, startedAt, version, checkedAt, reason?, warnings? }] }:
  // the last answer while it is fresh, the one in flight if any.
  function check() {
    const at = now();
    if (last && at - last.at < cacheMs) return last.result;
    const result = run();
    last = { at, result };
    return result;
  }

  return { check };
}

// Why a call failed, in a word: never its URL (fetch's messages may hold it).
export function reasonOf(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  const code = error?.cause?.code ?? error?.code;
  if (code === "ECONNREFUSED") return "refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "unknown host";
  if (code === "ECONNRESET") return "reset";
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return "timeout";
  return "unreachable";
}
