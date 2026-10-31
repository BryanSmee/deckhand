// What redacts secrets from runs' output (secrets.mjs, which lists them), with node:crypto alone:
// the API endpoints (../models/upstream.mjs) use it too, and agents/ imports them.
import { createHash } from "node:crypto";

export const REDACTED = "[redacted]";

// Shorter values are no credential, and would redact ordinary words. Also the shortest part of
// a secret that is redacted on its own: a value cut off in an error message (#242).
const MIN_LENGTH = 16;

// GitHub's token shapes (installation `ghs_`, OAuth `gho_`, personal `ghp_`, `github_pat_`…),
// whoever issued them: the broker's are listed too (runs.mjs), but not a token the agent found
// elsewhere. No `\b` before them: in a raw stream-json line, a token printed on a line of its
// own follows the two characters `\n`.
const GITHUB_TOKEN = /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{36,})/g;

// Deckhand's own run tokens (tokens.mjs), by the header the broker signs every one with
// (`{"alg":"EdDSA","typ":"JWT","kid":…`): the listener lists those it handed a sandbox, but the
// ones the sandbox renewed since come from the broker alone (#505), which keeps none to hand
// out. And its claims and signature alone (`cut -d. -f2-`): the header is the same for every
// token and its `kid` public, so they are the whole token. Its claims start with `{"ver":1,`.
// Another issuer's EdDSA JWT with the same header, or claims starting the same way, is
// redacted too: over-redaction in a reply, accepted, rather than a run token let through.
//
// Only from the start of a base64url run (or right after a `\n`, `\r`, `\t` escape, as in a
// raw stream-json line): a prefix repeated inside one would start a scan to its end at each
// occurrence, quadratic on a text a sandbox chooses (a screenshot, a GitHub write).
const START = String.raw`(?:(?<![A-Za-z0-9_-])|(?<=\\[nrt]))`;
const RUN_TOKEN_BODY = new RegExp(`${START}eyJ2ZXIiOjEs[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]{40,}`, "g");
const RUN_TOKEN = new RegExp(
  `${START}eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6I[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+`,
  "g",
);

// Every MIN_LENGTH-long part of a text holds a STEP-long one starting at a multiple of STEP:
// redact() only looks those up, then extends each hit both ways, rather than look up every
// position (a run's output goes through here line by line, on the event loop).
const STEP = MIN_LENGTH / 2;

// A JWT's header (`eyJhbGciOiJSUzI1NiIs…`) and the start of its payload (`.eyJ`) are the same
// in every token its issuer signs: not what makes a secret, and they would garble other JWTs in
// a reply. A match counts only with MIN_LENGTH characters past them.
const JWT_HEADER = /^eyJ[A-Za-z0-9_-]*\.eyJ/;

// Every STEP-long part of `secrets`, as [secret, offset, where its own part starts] (past a
// JWT's header, else 0). Kept for the last few lists asked for: each run redacts its lines with
// its own. Null: no secret is long enough.
const cache = new Map();
function windowsOf(secrets) {
  const usable = secrets.filter((s) => typeof s === "string" && s.length >= MIN_LENGTH);
  const key = usable.join("\0");
  if (cache.has(key)) return cache.get(key);
  let map = null;
  for (const secret of usable) {
    // A match counting has MIN_LENGTH characters past the header: a window among them.
    const own = JWT_HEADER.exec(secret)?.[0].length ?? 0;
    for (let i = own; i + STEP <= secret.length; i++) {
      const part = secret.slice(i, i + STEP);
      map ??= new Map();
      if (!map.has(part)) map.set(part, []);
      map.get(part).push([secret, i, own]);
    }
  }
  if (cache.size >= 16) cache.delete(cache.keys().next().value);
  cache.set(key, map);
  return map;
}

// [start, end) ranges of `text` where a part of `secrets` MIN_LENGTH long or more shows, in
// order, overlapping ones merged.
function matches(text, map) {
  const ranges = [];
  for (let j = 0; j + STEP <= text.length; j += STEP) {
    const found = map.get(text.slice(j, j + STEP));
    if (!found) continue;
    let end = 0;
    for (const [secret, i, own] of found) {
      let before = 0;
      while (before < i && before < j && secret[i - before - 1] === text[j - before - 1]) {
        before++;
      }
      let after = STEP;
      while (i + after < secret.length && secret[i + after] === text[j + after]) after++;
      if (i + after - Math.max(own, i - before) < MIN_LENGTH) continue;
      ranges.push([j - before, j + after]);
      end = Math.max(end, j + after);
    }
    // A match reaching past `end` holds a window starting after end - MIN_LENGTH: no need to
    // walk the matched text again.
    if (end) j = Math.max(j, Math.floor((end - MIN_LENGTH) / STEP) * STEP);
  }
  return merged(ranges);
}

// `ranges` in order, overlapping ones merged.
function merged(ranges) {
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const range of ranges) {
    const last = out.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else out.push([...range]);
  }
  return out;
}

// The credentials a service holds and doesn't share, by their fingerprints (#504, the models
// service's GET /fingerprints): { salt, values: [{ length, hash }], chunk, chunks }, each hash the
// SHA-256 of the salt and the value, or of one of its `chunk`-long parts at fixed offsets. Their
// values are unknown here, so what is found is a run of characters a credential is made of that
// is one of them whole, or holds one of their chunks: the whole run is redacted then, whatever
// is left of the credential around the chunk with it. A part of one cut off (#242) is found when
// it holds a whole chunk: 2 × chunk - 1 characters always do. Runs of narrower and wider sets of
// characters each, so that a credential next to `.`, `/` or `=` (a URL, `key=…`) is found as one
// too.
const CREDENTIAL_RUNS = [
  /[A-Za-z0-9_-]+/g,
  /[A-Za-z0-9._~-]+/g,
  /[A-Za-z0-9._~+/-]+/g,
  /[A-Za-z0-9._~+/=-]+/g,
];

const isPrints = (s) => typeof s?.salt === "string" && Array.isArray(s.values);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// [start, end) ranges of `text` that are one of `prints`' credentials, or hold a chunk of one.
function hashedMatches(text, prints) {
  const bySalt = prints.map(({ salt, values, chunk, chunks }) => ({
    salt,
    lengths: new Set(values.map((v) => v.length)),
    hashes: new Set(values.map((v) => v.hash)),
    chunk: Number.isInteger(chunk) && chunk >= MIN_LENGTH ? chunk : null,
    chunks: new Set(Array.isArray(chunks) ? chunks : []),
  }));
  const lengths = new Set(bySalt.flatMap((p) => [...p.lengths]));
  const ranges = [];
  for (const re of CREDENTIAL_RUNS) {
    for (const { 0: run, index } of text.matchAll(re)) {
      if (!lengths.has(run.length)) continue;
      const found = bySalt.some(
        (p) => p.lengths.has(run.length) && p.hashes.has(sha256(p.salt + run)),
      );
      if (found) ranges.push([index, index + run.length]);
    }
  }
  // Chunks, in the widest runs only: one holding a chunk is redacted whole, but for the dots
  // that end or start it (a sentence's), which no credential does.
  const chunked = bySalt.filter((p) => p.chunk && p.chunks.size);
  if (!chunked.length) return ranges;
  for (const match of text.matchAll(CREDENTIAL_RUNS.at(-1))) {
    const lead = /^\.*/.exec(match[0])[0].length;
    const run = match[0].slice(lead).replace(/\.+$/, "");
    const index = match.index + lead;
    const holds = chunked.some((p) => {
      for (let i = 0; i + p.chunk <= run.length; i++) {
        if (p.chunks.has(sha256(p.salt + run.slice(i, i + p.chunk)))) return true;
      }
      return false;
    });
    if (holds) ranges.push([index, index + run.length]);
  }
  return ranges;
}

// `text` without any of `secrets`, whole or any part of MIN_LENGTH characters or more, nor any
// GitHub token or run token. Among `secrets`, a credential's fingerprints (CREDENTIAL_RUNS) too.
export function redact(text, secrets) {
  const out = String(text);
  const prints = secrets.filter(isPrints);
  if (prints.length) secrets = secrets.filter((s) => !isPrints(s));
  const map = windowsOf(secrets);
  let result = "";
  let at = 0;
  const found = map ? matches(out, map) : [];
  if (prints.length) found.push(...hashedMatches(out, prints));
  for (const [start, end] of merged(found)) {
    result += out.slice(at, start) + REDACTED;
    at = end;
  }
  return (result + out.slice(at))
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(RUN_TOKEN, REDACTED)
    .replace(RUN_TOKEN_BODY, REDACTED);
}
