import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  isToken,
  keyId,
  MAX_TOKEN,
  RUN_AUDIENCE,
  signingKey,
  signToken,
  TokenError,
  verifyToken,
} from "../lib/tokens.mjs";
import { tempDir } from "./helpers.mjs";

const NOW = 1_900_000_000_000;
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, kid: keyId(publicKey) };
};
const key = pair();
const keys = new Map([[key.kid, key.publicKey]]);
const claims = { ver: 1, jti: "run-1", repo: "org/a", sandbox: "net-1", caps: [] };
const signed = (extra = {}, options = {}) =>
  signToken(
    { ...claims, ...extra },
    { ...key, audience: RUN_AUDIENCE, ttlMs: 15 * 60_000, now: NOW, ...options },
  );
const check = (token, options = {}) =>
  verifyToken(token, { keys, audience: RUN_AUDIENCE, now: NOW, ...options });
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const refused = (fn, why) =>
  assert.throws(fn, (error) => error instanceof TokenError && why.test(error.message));

test("a token's claims come back once its signature, audience and expiry check", () => {
  const token = signed();
  assert.ok(isToken(token));
  const got = check(token);
  assert.equal(got.jti, "run-1");
  assert.equal(got.sandbox, "net-1");
  assert.equal(got.aud, RUN_AUDIENCE);
  assert.equal(got.exp - got.iat, 15 * 60);
  // Readable by anyone: nothing in it is secret.
  const [head, body] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url")), {
    alg: "EdDSA",
    typ: "JWT",
    kid: key.kid,
  });
  assert.equal(JSON.parse(Buffer.from(body, "base64url")).repo, "org/a");
});

test("another algorithm, none among them, is refused whatever the header says", () => {
  const [, body] = signed().split(".");
  for (const alg of ["none", "HS256", "RS256", "eddsa"]) {
    const head = b64({ alg, typ: "JWT", kid: key.kid });
    const signature = sign(null, Buffer.from(`${head}.${body}`), key.privateKey);
    refused(() => check(`${head}.${body}.${signature.toString("base64url")}`), /EdDSA/);
  }
  // `none`'s empty signature isn't even a token's shape.
  refused(() => check(`${b64({ alg: "none" })}.${body}.`), /not a run token/);
  // An HMAC "signed" with the public key, the classic confusion: refused on its alg alone.
  refused(() => check(`${b64({ alg: "HS256", kid: key.kid })}.${body}.AAAA`), /EdDSA/);
});

test("another audience, an expired token, an unknown kid or another key are refused", () => {
  refused(() => check(signed(), { audience: "deckhand:agents" }), /not meant/);
  // An array of audiences isn't one service.
  refused(() => check(signed({}, { audience: [RUN_AUDIENCE, "deckhand:agents"] })), /not meant/);
  refused(() => check(signed(), { now: NOW + 15 * 60_000 }), /expired/);
  assert.equal(check(signed(), { now: NOW + 15 * 60_000 - 1000 }).jti, "run-1");
  const other = pair();
  refused(() => check(signed({}, other)), /unknown key/);
  // Another key under this key's kid: its signature doesn't match.
  refused(() => check(signed({}, { privateKey: other.privateKey })), /signature/);
  // Both keys while they rotate: each one's tokens check.
  const both = new Map([...keys, [other.kid, other.publicKey]]);
  assert.equal(check(signed({}, other), { keys: both }).jti, "run-1");
  // A claim changed after signing.
  const [head, , signature] = signed().split(".");
  const forged = `${head}.${b64({ ...check(signed()), repo: "org/b" })}.${signature}`;
  refused(() => check(forged), /signature/);
  // Claims of a format this listener doesn't know.
  refused(() => check(signed({ ver: 2 })), /version/);
});

test("a token over the size limit is never signed", () => {
  const branches = Array.from({ length: 200 }, (_, i) => `issue-${i}-a-long-branch-name`);
  assert.throws(() => signed({ branches }), /over 2048/);
  assert.ok(signed({ branches: branches.slice(0, 10) }).length <= MAX_TOKEN);
});

test("the signing key is made once, owner-only, and the same after a restart", (t) => {
  const dir = tempDir(t);
  const first = signingKey(dir);
  assert.equal(statSync(`${dir}/run-token.key`).mode & 0o777, 0o600);
  const again = signingKey(dir);
  assert.equal(again.kid, first.kid);
  const token = signToken(claims, { ...first, audience: RUN_AUDIENCE, ttlMs: 60_000, now: NOW });
  const known = new Map([[again.kid, again.publicKey]]);
  assert.equal(verifyToken(token, { keys: known, audience: RUN_AUDIENCE, now: NOW }).jti, "run-1");
});

test("a signing key file that isn't a key stops the listener saying what to do, never replaced", (t) => {
  const dir = tempDir(t);
  // Half a PEM, as a write cut short by an older listener would leave.
  writeFileSync(join(dir, "run-token.key"), "-----BEGIN PRIVATE KEY-----\nMC4CAQAw");
  assert.throws(
    () => signingKey(dir),
    /run-token\.key isn't a key .*: remove it, and a new one is made/,
  );
  assert.equal(
    readFileSync(join(dir, "run-token.key"), "utf8"),
    "-----BEGIN PRIVATE KEY-----\nMC4CAQAw",
  );
  // Made whole: nothing but the key in the folder.
  const fresh = tempDir(t);
  signingKey(fresh);
  assert.deepEqual(readdirSync(fresh), ["run-token.key"]);
});
