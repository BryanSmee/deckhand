// What redacts secrets from runs' output (secrets.mjs, which lists them), without imports: the
// API endpoints (upstream.mjs) use it too, and agents/ imports them.

export const REDACTED = "[redacted]";

// Shorter values are no credential, and would redact ordinary words. Also the shortest part of
// a secret that is redacted on its own: a value cut off in an error message (#242).
const MIN_LENGTH = 16;

// GitHub's token shapes (installation `ghs_`, OAuth `gho_`, personal `ghp_`, `github_pat_`…),
// whoever issued them: the broker's are listed too (runs.mjs), but not a token the agent found
// elsewhere. No `\b` before them: in a raw stream-json line, a token printed on a line of its
// own follows the two characters `\n`.
const GITHUB_TOKEN = /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{36,})/g;

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
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

// `text` without any of `secrets`, whole or any part of MIN_LENGTH characters or more, nor any
// GitHub token.
export function redact(text, secrets) {
  const out = String(text);
  const map = windowsOf(secrets);
  let result = "";
  let at = 0;
  for (const [start, end] of map ? matches(out, map) : []) {
    result += out.slice(at, start) + REDACTED;
    at = end;
  }
  return (result + out.slice(at)).replace(GITHUB_TOKEN, REDACTED);
}
