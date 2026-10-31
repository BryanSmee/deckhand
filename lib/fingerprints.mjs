// Secrets a service redacts without holding them (#502): the github service redacts the
// operator's agent credentials from the runs' GitHub writes, as the listener's gateway did, but
// holds none of them (each secret in one service, #499). The service that holds them sends
// their fingerprints instead: a salted SHA-256 of each whole secret, with its length, which find
// it in a text, and which no one can turn back into it short of guessing the whole of it. Never
// one of its parts: parts that overlap would give it away a character at a time, from what is
// known of its shape (`sk-ant-…`). So a secret cut short in a text isn't found, as redact()
// would find it down to MIN_LENGTH: the cost of not holding it.
//
// A text is read once per length: a rolling hash of each of its windows (Rabin–Karp, its base
// from the salt) first, then the SHA-256 of the few windows whose rolling hash matches one's.
// What is kept of a secret's rolling hash is 12 of its bits (ROLL_BITS) only: the hash is linear,
// so the whole of it would spare a guesser of a secret whose start is known about 2^31 of the
// work; 12 bits spare 2^12, nothing for a secret of 16 random characters and more, and still
// leave one window in 4096 for SHA-256.
import { createHash, randomBytes } from "node:crypto";
import { REDACTED } from "./redact.mjs";

// The shortest secret fingerprinted, as redact()'s MIN_LENGTH; the most kept.
export const MIN_LENGTH = 16;
export const MAX_PRINTS = 1000;

const MOD = 2147483647; // 2^31 - 1
const ROLL_BITS = 12;
const kept = (h) => h % (1 << ROLL_BITS);
const sha = (salt, text) => createHash("sha256").update(salt).update(text).digest("base64url");
// The rolling hash's base, from the salt: 256 to 65535.
const baseOf = (salt) =>
  256 + (createHash("sha256").update(`base:${salt}`).digest().readUInt16BE(0) % 65000);

function roll(text, base) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * base + text.charCodeAt(i)) % MOD;
  return h;
}

// `secrets` (strings) → { salt, prints: ["<length>:<rolling hash's 12 bits>:<sha-256>"] }: what goes to the
// service that redacts them. A new salt each time unless one is given.
export function fingerprint(secrets, salt = randomBytes(16).toString("hex")) {
  const base = baseOf(salt);
  const prints = new Set();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < MIN_LENGTH) continue;
    if (prints.size >= MAX_PRINTS) break;
    prints.add(`${secret.length}:${kept(roll(secret, base))}:${sha(salt, secret)}`);
  }
  return { salt, prints: [...prints] };
}

// fingerprint()'s → (text) → the text with each secret it finds replaced by REDACTED. Nothing to
// look for: the text as it is.
export function fingerprintRedactor(fingerprints) {
  const salt = fingerprints?.salt;
  // length → rolling hash → its SHA-256s
  const byLength = new Map();
  for (const p of Array.isArray(fingerprints?.prints) ? fingerprints.prints : []) {
    const [length, rolled, hash] = String(p).split(":");
    const n = Number(length);
    if (!Number.isSafeInteger(n) || n < MIN_LENGTH || !hash) continue;
    if (!byLength.has(n)) byLength.set(n, new Map());
    const rolls = byLength.get(n);
    if (!rolls.has(Number(rolled))) rolls.set(Number(rolled), new Set());
    rolls.get(Number(rolled)).add(hash);
  }
  if (typeof salt !== "string" || !byLength.size) return (text) => text;
  const base = baseOf(salt);

  // Where each secret of length `n` starts in `text`.
  function starts(text, n, rolls) {
    const found = [];
    if (text.length < n) return found;
    let top = 1; // base^(n-1)
    for (let i = 1; i < n; i++) top = (top * base) % MOD;
    let h = roll(text.slice(0, n), base);
    for (let i = 0; ; i++) {
      if (rolls.get(kept(h))?.has(sha(salt, text.slice(i, i + n)))) found.push(i);
      if (i + n >= text.length) return found;
      h = (h - ((text.charCodeAt(i) * top) % MOD) + MOD) % MOD;
      h = (h * base + text.charCodeAt(i + n)) % MOD;
    }
  }

  return (text) => {
    if (typeof text !== "string" || text.length < MIN_LENGTH) return text;
    const spans = [];
    for (const [n, rolls] of byLength) {
      for (const i of starts(text, n, rolls)) spans.push([i, i + n]);
    }
    if (!spans.length) return text;
    spans.sort((a, b) => a[0] - b[0]);
    let out = "";
    let at = 0;
    for (const [start, end] of spans) {
      if (end <= at) continue;
      out += text.slice(at, Math.max(at, start)) + (start >= at ? REDACTED : "");
      at = end;
    }
    return out + text.slice(at);
  };
}
