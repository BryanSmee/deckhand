// Run tokens (#493), and the services' own (#500, service-token.mjs). A run token is what a
// sandbox holds in place of a GitHub token or the operator's credential, a JWT the broker signs with Ed25519 (broker.mjs) and every service checks with the
// public key alone, without asking the broker: a service that can check a token can't mint one
// (no HMAC). Hand-written on node:crypto, and strict:
//
//   - the algorithm is EdDSA, always: the header's `alg` is never what picks it, and any other
//     (`none` among them) is refused;
//   - `kid` names the key, so a service can hold the old and the new one while keys rotate;
//   - `aud` is one string, the service the token is for: a run token for the broker's services,
//     another for the agents' API endpoints;
//   - `exp` is checked, against the caller's clock.
//
// The claims are what doesn't change during a run, nothing secret: the sandbox may read them, to
// know what it may do. `ver` is their format's version: a sandbox outlives a listener update.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign,
  verify,
} from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./files.mjs";

// The claims' format.
export const TOKEN_VERSION = 1;

// A token's size at most, checked when it is signed: Node takes 16 KB of headers, and git's
// Basic auth (`x-access-token:<token>` in base64) adds a third to it.
export const MAX_TOKEN = 2048;

// The audiences: the broker's services (the GitHub gateway, the git gateway, the run's files and
// the renewal), and the agents' API endpoints (upstream.mjs).
export const RUN_AUDIENCE = "deckhand:broker";
export const AGENT_AUDIENCE = "deckhand:agents";

// A run token's lifetime, and how often the sandbox renews it (../sandbox/deckhand-token): two
// renewals may fail before it expires.
export const TOKEN_TTL_MS = 15 * 60_000;
export const RENEW_EVERY_S = 5 * 60;

// The agent token's: it is in the agent's environment from its start, which a running process
// never reads again, so it can't be renewed. Bound to the run's network or pod as the run token
// is, it dies with the run; this is only a ceiling.
export const AGENT_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;

// How long past its expiry a run token still renews, from its own sandbox and while its run
// lasts: a broker unreachable for longer than a token's life (a slow update, a host reboot)
// leaves the sandbox nothing else to present, so its calls fail until the broker is back, not
// for the rest of the run. As long as the agent token, which outlives a pause of the broker anyway.
export const RENEW_GRACE_MS = 7 * 24 * 60 * 60_000;

// How long a key that signed run tokens before the broker service (the listener's
// `run-token.key`, #505) still checks them: as long as one of its tokens may still be
// presented, the agent's or a run token's renewal.
export const LEGACY_KEY_MS = Math.max(AGENT_TOKEN_TTL_MS, TOKEN_TTL_MS + RENEW_GRACE_MS);

const HEADER_RE = /^[A-Za-z0-9_-]+$/;

// Why a token was refused, for the service's answer: nothing in it is secret.
export class TokenError extends Error {}

// A public key, as a KeyObject: from one, a PEM or a private key.
function publicOf(key) {
  return key instanceof KeyObject && key.type === "public" ? key : createPublicKey(key);
}

const b64 = (value) => Buffer.from(value).toString("base64url");

function json(part) {
  if (!HEADER_RE.test(part)) throw new TokenError("not a token");
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // Refused below.
  }
  throw new TokenError("not a token");
}

// Whether `value` has a JWT's shape, three base64url parts: what a service tells a token from
// a run secret of before them by (broker.mjs check()).
export function isToken(value) {
  return (
    typeof value === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  );
}

// A public key's id: the start of its SPKI's SHA-256, so the same key always has the same one.
export function keyId(publicKey) {
  const der = publicOf(publicKey).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("base64url").slice(0, 16);
}

// The broker's signing key, a PEM file in `dir`: created once, when there is none, written
// whole or not at all (a crash leaves none), owner-only. A file that can't be read, or isn't
// an Ed25519 key, stops the listener, saying what to do: a new key would refuse the running
// sandboxes' tokens, so it is never made in its place silently. → { privateKey, publicKey, kid }.
export function signingKey(dir) {
  const path = join(dir, "run-token.key");
  let pem;
  try {
    pem = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    writeFileAtomic(path, pem, { mode: 0o600 });
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(pem);
  } catch (error) {
    throw new Error(`${path} isn't a key (${error.message}): remove it, and a new one is made`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`${path} isn't an Ed25519 key: remove it, and a new one is made`);
  }
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, kid: keyId(publicKey) };
}

// A signed token: `claims` with `aud`, `iat` and `exp` (seconds) added. Over MAX_TOKEN, an error:
// a token git or Node would cut must never reach a sandbox.
export function signToken(claims, { privateKey, kid, audience, ttlMs, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const header = b64(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid }));
  const body = b64(
    JSON.stringify({ ...claims, aud: audience, iat, exp: iat + Math.ceil(ttlMs / 1000) }),
  );
  const signed = `${header}.${body}`;
  const token = `${signed}.${sign(null, Buffer.from(signed), privateKey).toString("base64url")}`;
  if (token.length > MAX_TOKEN) {
    throw new Error(`a run token of ${token.length} bytes, over ${MAX_TOKEN}: too many claims`);
  }
  return token;
}

// `token`'s claims once checked, or a TokenError saying why not. `keys`: kid → public key (a
// KeyObject or PEM); `audience`: the one service checking; `graceMs`: how long past its `exp`
// it is still taken (0 but for a renewal, broker.mjs renew()).
export function verifyToken(token, { keys, audience, now = Date.now(), graceMs = 0 }) {
  if (!isToken(token)) throw new TokenError("not a token");
  const [head, body, signature] = token.split(".");
  const header = json(head);
  // Never the header's choice: EdDSA is the only algorithm, whatever it says.
  if (header.alg !== "EdDSA") throw new TokenError("not signed with EdDSA");
  const key = typeof header.kid === "string" && keys.get(header.kid);
  if (!key) throw new TokenError("signed with an unknown key");
  const publicKey = publicOf(key);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new TokenError("not an Ed25519 key");
  const ok = verify(
    null,
    Buffer.from(`${head}.${body}`),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  if (!ok) throw new TokenError("its signature doesn't match");
  const claims = json(body);
  if (typeof claims.aud !== "string" || claims.aud !== audience) {
    throw new TokenError("not meant for this service");
  }
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 + graceMs <= now)
    throw new TokenError("expired");
  if (claims.ver !== TOKEN_VERSION) throw new TokenError(`claims of version ${claims.ver}`);
  return claims;
}

// Where the services that check the broker's tokens offline find its public keys (#501): a folder
// the broker writes and they mount read-only (SERVICE_KEYS_DIR), one `<kid>.pem` per key. A key
// is public: nothing else is in it.
export function publishKey(dir, { publicKey, kid }) {
  const pem = publicOf(publicKey).export({ type: "spki", format: "pem" });
  writeFileAtomic(join(dir, `${kid}.pem`), pem, { mode: 0o644 });
}

// The public keys in `dir` (publishKey()'s), as verifyToken() takes `keys`: `get(kid)` reads the
// folder again for a key it hasn't seen, a new one or one published after the service started,
// at most once every `everyMs`, so a flood of unknown kids reads it no more often. A file that
// isn't a key is skipped: its kid is unknown.
export function keyFolder(dir, { now = Date.now, everyMs = 1000 } = {}) {
  let keys = new Map();
  let readAt = -Infinity;
  function read() {
    readAt = now();
    const found = new Map();
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      // No folder yet: no key.
    }
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]+\.pem$/.test(name)) continue;
      try {
        const key = createPublicKey(readFileSync(join(dir, name), "utf8"));
        if (key.asymmetricKeyType === "ed25519") found.set(keyId(key), key);
      } catch {
        // Not a key.
      }
    }
    keys = found;
  }
  return {
    get(kid) {
      if (!keys.has(kid) && now() - readAt >= everyMs) read();
      return keys.get(kid);
    },
  };
}
