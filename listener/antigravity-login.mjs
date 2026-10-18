// A Google AI plan's login for the Antigravity CLI, held by the listener alone (AGY_AUTH_FILE:
// the token file `agy` writes when you sign in, ~/.gemini/antigravity-cli/antigravity-oauth-token).
// Its refresh token is an account-wide credential, and its access token is the plan's: neither
// enters a sandbox. Sandboxes keep their run's secret in its place, google.mjs asks this module
// for the plan's header, and the refresh happens here, one at a time, written back to the file
// for the next start.
//
// The refresh is `agy`'s own: the listener doesn't reimplement Google's OAuth with a client
// secret taken from the binary. When the access token is within 5 minutes of its expiry, a short
// container runs `agy models` on the login's own volume (../sandbox/agents/antigravity/refresh),
// with the file's expiry set in the past so that `agy` refreshes it, and hands the file back.
//
// The file: {"auth_method": "consumer", "token": {access_token, token_type, refresh_token,
// expiry}}, `expiry` an RFC 3339 time (checked against agy 1.4.0).
import { constants } from "node:fs";
import { access, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hardening } from "./docker.mjs";

const EARLY_MS = 5 * 60_000;
// What makes `agy` refresh: an expiry that has passed (not Go's zero time, which never expires).
const EXPIRED = "2000-01-01T00:00:00Z";
// What a refused refresh says, in `agy`'s log line the container prints (golang's oauth2:
// `oauth2: "invalid_grant" "Token has been expired or revoked."`): the refresh token is spent
// or revoked, retrying won't help. `agy` itself says "Please sign in" for that and for a Google
// it couldn't reach alike.
const REFUSED = /invalid_grant|invalid_client|unauthorized_client|revoked/i;

// Refused for good: signing in again is the fix. 401: a bad credential, for a fallback
// (agents/ providerError()).
class LoginError extends Error {
  status = 401;
}

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
  config, // image, agyVolume, agyVersion, agyLoginVolume, installNetwork
  docker, // docker.mjs's
  install = async () => {}, // the Antigravity CLI in its volume (images.installAgent())
  now = Date.now,
  log = () => {},
}) {
  let login = null; // { mtimeMs, json }: the file as last read or written
  let refreshing = null; // the one refresh in flight, which every caller awaits
  let stale = null; // an access token Google refused: refreshed on the next call
  let broken = null; // a LoginError, until the file changes

  // Its folder must take the refreshed file (a new one renamed over it): checked before any
  // refresh, which would otherwise spend the login and lose its result.
  async function writable() {
    try {
      await access(dirname(file), constants.W_OK);
    } catch (error) {
      throw new LoginError(
        `AGY_AUTH_FILE (${file}) must be in a folder the listener can write to (${error.code}): it rewrites the file at each refresh. Put it in the credentials folder, /data/credentials (docs/setup.md#antigravity-cli)`,
      );
    }
  }

  // The file again when someone replaced it (a new sign-in), else what we hold.
  async function load() {
    const { mtimeMs } = await stat(file);
    if (login?.mtimeMs === mtimeMs) return login.json;
    await writable();
    const json = parseLogin(await readFile(file, "utf8"), file);
    login = { mtimeMs, json };
    broken = null;
    return json;
  }

  function due(json) {
    if (json.token.access_token === stale) return true;
    const expiry = Date.parse(json.token.expiry ?? "");
    return !Number.isFinite(expiry) || expiry - EARLY_MS <= now();
  }

  // `agy models` in a container of its own: the file in, the file `agy` left out. Outside the
  // runs' networks (INSTALL_NETWORK, as the installs): no repo or agent input runs here.
  async function refresh(json) {
    await install();
    const forced = { ...json, token: { ...json.token, expiry: EXPIRED } };
    const result = await docker(
      [
        "run",
        "--rm",
        "-i",
        ...["--network", config.installNetwork],
        ...["--user", "1000:1000", ...hardening()],
        ...["-e", `AGY_VERSION=${config.agyVersion}`],
        ...["-v", `${config.agyVolume}:/opt/antigravity:ro`],
        ...["-v", `${config.agyLoginVolume}:/home/node/.gemini`],
        ...["--entrypoint", "deckhand-antigravity-refresh"],
        config.image,
      ],
      { input: JSON.stringify(forced) },
    );
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
        throw new LoginError(`${message}: sign in with \`agy\` again for AGY_AUTH_FILE`);
      }
      throw new Error(message);
    }
    // Atomically, so a crash leaves one file or the other.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
    await rename(tmp, file);
    login = { mtimeMs: (await stat(file)).mtimeMs, json: next };
    stale = null;
    log("Antigravity CLI: refreshed the Google AI plan's login");
    return next;
  }

  // The header that makes a call the plan's. Throws when there is no usable login.
  async function headers() {
    let json = await load();
    if (broken) throw broken;
    if (due(json)) {
      refreshing ??= refresh(json)
        .catch((error) => {
          if (error instanceof LoginError) broken = error;
          throw error;
        })
        .finally(() => (refreshing = null));
      json = await refreshing;
    }
    return { authorization: `Bearer ${json.token.access_token}` };
  }

  // Google refused this access token (401): the next call refreshes it first, once.
  function refused(authorization) {
    const token = String(authorization).replace(/^Bearer /, "");
    if (token === login?.json.token.access_token) stale = token;
  }

  // Its tokens as last read: redacted from runs' output like the other credentials, though
  // no sandbox has them.
  function secrets() {
    const token = login?.json.token ?? {};
    return [token.access_token, token.refresh_token];
  }

  return { headers, refused, secrets };
}
