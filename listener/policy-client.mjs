// The policy service as the listener calls it (#501, ../policy-service/service.mjs): every
// decision, the config checks and the Policies tab go there, and the listener starts no `opa`.
// The same three methods as the service's engine (../policy-service/engine.mjs createEngine()),
// which the tests pass in its place: policies(), evaluate(body), compile(body).
//
// Each call carries a service token (`header()`: lib/service-token.mjs serviceTokens()'s). A
// service that refuses the connection or answers 503 (stopping, or not started yet) is asked again
// until WAIT_MS: an update of the service, or a copy that stops, is a wait rather than a
// refusal. After it, or for any other failure, the call throws, and the decision refuses with a
// `policy error` (fail closed).

// How long a call waits for a service that doesn't take it: a restart's drain and start.
export const WAIT_MS = 30_000;
// Between two tries.
const RETRY_MS = 500;
// One call at most, once taken: longer than the service's worst case for a set's first decision,
// its check (10 s), its opa's start (10 s) and the query (2 s), so that a slow first decision isn't
// refused here while the service still finishes it.
export const CALL_TIMEOUT_MS = 30_000;

// Whether `error` (fetch's) is a connection the service didn't take: refused, reset before an
// answer, or a name that doesn't resolve yet (a container that is starting).
function notTaken(error) {
  const code = error?.cause?.code ?? error?.code;
  return ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(code);
}

// `url`: the service (POLICY_SERVICE_URL); `header()`: the Authorization header for it.
export function policyClient({
  url,
  header,
  fetch = globalThis.fetch,
  waitMs = WAIT_MS,
  retryMs = RETRY_MS,
  timeoutMs = CALL_TIMEOUT_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const base = url.replace(/\/$/, "");

  async function call(method, path, body) {
    const until = now() + waitMs;
    for (;;) {
      let res;
      let why;
      try {
        res = await fetch(`${base}${path}`, {
          method,
          headers: {
            authorization: await header(),
            ...(body !== undefined && { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error?.name === "TimeoutError") {
          throw new Error(`the policy service didn't answer within ${timeoutMs / 1000} s`);
        }
        if (!notTaken(error)) {
          throw new Error(`the policy service can't be reached (${error.cause?.code ?? error})`);
        }
        why = error.cause?.code ?? error.code;
      }
      if (res && res.status !== 503) {
        const text = await res.text();
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          // Said below.
        }
        if (res.ok && value && typeof value === "object") return value;
        throw new Error(
          `the policy service answered ${res.status}${value?.error ? `: ${value.error}` : ""}`,
        );
      }
      if (res) {
        why = "503";
        await res.body?.cancel();
      }
      if (now() + retryMs > until) {
        throw new Error(
          `the policy service can't be reached (${why}, for ${Math.round(waitMs / 1000)} s)`,
        );
      }
      await sleep(retryMs);
    }
  }

  return {
    policies: () => call("GET", "/policies"),
    evaluate: (body) => call("POST", "/evaluate", body),
    compile: (body) => call("POST", "/check", body),
  };
}
