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
import { readFileSync } from "node:fs";
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
