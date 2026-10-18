// What redacts secrets from runs' output (secrets.mjs, which lists them), without imports: the
// API endpoints (upstream.mjs) use it too, and agents/ imports them.

export const REDACTED = "[redacted]";

// Shorter values are no credential, and would redact ordinary words. Also the shortest part of
// a secret that is redacted on its own: a value cut off in an error message (#242).
const MIN_LENGTH = 16;

// GitHub's token shapes (installation `ghs_`, OAuth `gho_`, personal `ghp_`, `github_pat_`…),
// whoever issued them: the broker's are listed too (runs.mjs), but not a token the agent found
// elsewhere.
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{36,})/g;

// Every part of `secrets` at least MIN_LENGTH long, by its first MIN_LENGTH characters: [secret,
// offset] pairs. Kept for the last few lists asked for: each run redacts its lines with its own.
const cache = new Map();
function windowsOf(secrets) {
  const usable = secrets.filter((s) => typeof s === "string" && s.length >= MIN_LENGTH);
  const key = usable.join("\0");
  let map = cache.get(key);
  if (map) return map;
  map = new Map();
  for (const secret of usable) {
    for (let i = 0; i + MIN_LENGTH <= secret.length; i++) {
      const part = secret.slice(i, i + MIN_LENGTH);
      if (!map.has(part)) map.set(part, []);
      map.get(part).push([secret, i]);
    }
  }
  if (cache.size >= 16) cache.delete(cache.keys().next().value);
  cache.set(key, map);
  return map;
}

// `text` without any of `secrets`, whole or any part of MIN_LENGTH characters or more, nor any
// GitHub token.
export function redact(text, secrets) {
  const out = String(text);
  const map = windowsOf(secrets);
  // [start, end) ranges of `out` to redact, in order, overlapping ones merged.
  const ranges = [];
  for (let j = 0; j + MIN_LENGTH <= out.length; j++) {
    const found = map.get(out.slice(j, j + MIN_LENGTH));
    if (!found) continue;
    let end = j + MIN_LENGTH;
    for (const [secret, i] of found) {
      let k = MIN_LENGTH;
      while (i + k < secret.length && j + k < out.length && secret[i + k] === out[j + k]) k++;
      end = Math.max(end, j + k);
    }
    const last = ranges.at(-1);
    if (last && j <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([j, end]);
    // A match reaching past `end` has a window starting at end - MIN_LENGTH + 1 or later.
    j = Math.max(j, end - MIN_LENGTH);
  }
  let result = "";
  let at = 0;
  for (const [start, end] of ranges) {
    result += out.slice(at, start) + REDACTED;
    at = end;
  }
  return (result + out.slice(at)).replace(GITHUB_TOKEN, REDACTED);
}
