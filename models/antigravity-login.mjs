// A Google AI plan's login for the Antigravity CLI, held by the models service alone
// (AGY_AUTH_FILE: the token file `agy` writes when you sign in,
// ~/.gemini/antigravity-cli/antigravity-oauth-token). Its refresh token is an account-wide
// credential, and its access token is the plan's: neither enters a sandbox. Sandboxes keep their
// run's agent token in its place, google.mjs asks this module for the plan's header, and the
// refresh happens here, once for every copy of the service, its result kept sealed in the store
// (logins.mjs).
//
// The refresh is `agy`'s own: the service doesn't reimplement Google's OAuth with a client
// secret taken from the binary. When the access token is within 5 minutes of its expiry, the
// runner service runs `agy models` in a short container on the login's own volume (a pod of its
// own on Kubernetes, the file in and out through the API server's attach)
// (../sandbox/agents/antigravity/refresh, ../runner/service.mjs loginRefresh()), with the file's
// expiry set in the past so that `agy` refreshes it, and hands the file back: the models service
// never holds the Docker socket.
//
// The file: {"auth_method": "consumer", "token": {access_token, token_type, refresh_token,
// expiry}}, `expiry` an RFC 3339 time (checked against agy 1.4.0).
import { randomBytes } from "node:crypto";
import { openStore } from "../lib/store.mjs";
import { LoginError, loginSeal, planLogin } from "./logins.mjs";

const EARLY_MS = 5 * 60_000;
// What makes `agy` refresh: an expiry that has passed (not Go's zero time, which never expires).
const EXPIRED = "2000-01-01T00:00:00Z";
// What a refused refresh says, in `agy`'s log line the container prints (golang's oauth2:
// `oauth2: "invalid_grant" "Token has been expired or revoked."`): the refresh token is spent
// or revoked, retrying won't help. `agy` itself says "Please sign in" for that and for a Google
// it couldn't reach alike.
const REFUSED = /invalid_grant|invalid_client|unauthorized_client|revoked/i;

// The token file's JSON, or a LoginError naming `file`.
function parseLogin(text, file) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!json?.token?.access_token || !json.token.refresh_token) {
    throw new LoginError(
      `${file} holds no Antigravity CLI login (sign in with \`agy\` for one, docs/setup.md)`,
    );
  }
  return json;
}

export function createAntigravityLogin({
  file, // AGY_AUTH_FILE
  config, // runner
  // (input, { timeoutMs }) → { code, out, err }: the refresh's container, `input` on its stdin,
  // within `timeoutMs`, what is left of the lease on the login (the runner's
  // POST /logins/antigravity/refresh, ../runner/client.mjs refreshLogin()); null: none
  refresh: runRefresh = null,
  // Where the refreshed login is kept, sealed (logins.mjs): the service's store and key; none, a
  // store of this copy's own.
  store = openStore("memory:"),
  seal = loginSeal(randomBytes(32)),
  holder,
  now = Date.now,
  sleep,
  log = () => {},
}) {
  function due(json) {
    const expiry = Date.parse(json.token.expiry ?? "");
    return !Number.isFinite(expiry) || expiry - EARLY_MS <= now();
  }

  // `agy models` in a container of the runner's: the login in, the one `agy` left out.
  // `until`: when the lease on the login runs out (logins.mjs): the runner is told what is left
  // of it, and ends its job before.
  async function refresh(json, { until } = {}) {
    if (!runRefresh) throw new Error(`the ${config.runner} runner runs no login refresh`);
    const forced = { ...json, token: { ...json.token, expiry: EXPIRED } };
    const result = await runRefresh(JSON.stringify(forced), {
      ...(until !== undefined && { timeoutMs: Math.max(0, until - now()) }),
    });
    let next = null;
    try {
      next = parseLogin(result.out, file);
    } catch {}
    const fresh =
      next &&
      next.token.access_token !== json.token.access_token &&
      Date.parse(next.token.expiry ?? "") > now();
    if (!fresh) {
      // From stderr only: stdout is the token file (#242).
      const why =
        (result.err ?? "").trim().split("\n").at(-1) || `exit ${result.code}, nothing on stderr`;
      const message = `the Antigravity CLI's login can't be refreshed (${why.slice(0, 300)})`;
      if (result.code !== 0 && REFUSED.test(result.err ?? "")) {
        throw new LoginError(`${message}: sign in with \`agy\` again for AGY_AUTH_FILE`, {
          refused: true,
        });
      }
      throw new Error(message);
    }
    log("Antigravity CLI: refreshed the Google AI plan's login");
    return next;
  }

  return planLogin({
    store,
    seal,
    name: "antigravity",
    file,
    parse: (text) => parseLogin(text, file),
    now,
    ...(holder && { holder }),
    ...(sleep && { sleep }),
    due,
    refresh,
    headersOf: (json) => ({ authorization: `Bearer ${json.token.access_token}` }),
    accessOf: (json) => json.token.access_token,
    secretsOf: (json) => [json.token.access_token, json.token.refresh_token],
  });
}
