// Calling another service (#499): its URLs, the caller's service token for it
// (service-token.mjs serviceTokens()), and the orchestrator's fencing epoch on each call. A
// service that is away (updating, handing over to its other copy) is waited for rather than
// failed: a refused connection or a 503 is tried again, on its next URL if it has several (two
// copies behind no load balancer, in the tests), until `waitMs` ends. Every other answer is the
// caller's to read, as fetch() gives it.

// The header the orchestrator's fencing epoch travels in (#506): the services it calls refuse
// one older than the newest they have seen (409).
export const EPOCH_HEADER = "x-deckhand-epoch";

// The proxy waits as long for a service that refuses its connection (proxy/wait.mjs, #507).
export const WAIT_MS = 5 * 60_000;

// A service that didn't answer within `waitMs`.
export class Unavailable extends Error {}

// Network errors fetch() gives for a service that isn't there (yet): "before" when the call
// never reached it (refused, no such host while its container restarts), "cut" when the
// connection broke once made (reset): the service may have taken the call. null: another
// error, not tried again.
const BEFORE = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"];
function unreachable(error) {
  const code = error?.cause?.code ?? error?.code;
  if (BEFORE.includes(code)) return "before";
  if (error?.name === "TypeError" || ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code)) {
    return "cut";
  }
  return null;
}

// `urls`: the service's, comma-separated or a list; `token()`: the Authorization header for it
// (serviceTokens().header(aud)), or null; `epoch()`: the caller's epoch, or null for a caller
// that has none (only the orchestrator's calls carry one).
export function serviceClient({
  service,
  urls,
  token = async () => null,
  epoch = () => null,
  fetch = globalThis.fetch,
  waitMs = WAIT_MS,
  retryMs = 500,
  maxRetryMs = 5000,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  const bases = (Array.isArray(urls) ? urls : String(urls ?? "").split(","))
    .map((u) => u.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (!bases.length) throw new Error(`no URL for the ${service} service`);
  let current = 0;

  // → fetch()'s Response. `body`: a Buffer, text, or a value sent as JSON; `retry: false`: not
  // tried again at all. `waitMs`: this call's own, shorter for one with an answer to fall back
  // on. `once`: a call that mustn't be made twice (the Antigravity login's refresh spends its
  // token), tried again only when it never reached the service.
  async function request(
    method,
    path,
    { body, headers = {}, signal, retry = true, once = false, waitMs: wait = waitMs } = {},
  ) {
    const started = now();
    let delay = retryMs;
    let said = false;
    for (;;) {
      const base = bases[current];
      let answer = null;
      let failure = null;
      try {
        const authorization = await token();
        const fenced = epoch();
        const json = body !== undefined && !Buffer.isBuffer(body) && typeof body !== "string";
        answer = await fetch(`${base}${path}`, {
          method,
          signal,
          headers: {
            ...(authorization && { authorization }),
            ...(fenced != null && { [EPOCH_HEADER]: String(fenced) }),
            ...(json && { "content-type": "application/json" }),
            ...headers,
          },
          body: json ? JSON.stringify(body) : body,
        });
      } catch (error) {
        const why = unreachable(error);
        if (signal?.aborted || !why || (once && why === "cut")) throw error;
        failure = error.cause?.code ?? error.message;
      }
      if (answer && answer.status !== 503) return answer;
      // The copy there is passive, draining or gone: the next one, after a pause.
      if (answer) {
        failure = `503 ${(await answer.text().catch(() => "")).slice(0, 200)}`;
      }
      if (!retry || now() - started >= wait) {
        throw new Unavailable(`the ${service} service didn't answer (${failure})`);
      }
      if (!said) log(`The ${service} service: ${failure}, trying again`);
      said = true;
      current = (current + 1) % bases.length;
      await sleep(delay);
      delay = Math.min(delay * 2, maxRetryMs);
    }
  }

  // The answer's JSON, or an Error with the service's message for any other status.
  async function json(method, path, options) {
    const res = await request(method, path, options);
    const text = await res.text();
    let value = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      // Said below.
    }
    if (!res.ok) {
      const reason = value?.message ?? text.slice(0, 300);
      const error = new Error(`the ${service} service: ${res.status} ${reason}`);
      error.status = res.status;
      // What the service said, for a caller that passes it on as its own (a run's start).
      error.reason = reason;
      throw error;
    }
    return value;
  }

  return { request, json };
}
