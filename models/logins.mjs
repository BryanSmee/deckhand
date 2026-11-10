// The plans' logins as every copy of the models service shares them (#504): the ChatGPT plan's
// (chatgpt.mjs) and the Google AI plan's (antigravity-login.mjs), whose refresh tokens are
// single-use. One refresh at a time for every copy: a lease in the store, its holder refreshes
// and the other copies wait for its result. The refreshed login is in the store, sealed with a
// key only the models service holds (loginKey()): the store may be Redis, which every service
// reads (#509).
//
// The operator's file (CODEX_AUTH_FILE, AGY_AUTH_FILE) is only where a login starts: read, never
// written, so it may be mounted read-only. The store's login is the one used until the file
// changes (a new sign-in, by its content's hash), which then replaces it.
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { sealWith } from "../lib/seal.mjs";
import { LOGIN_REFRESH_MS } from "../lib/services.mjs";

// How long a refresh may take before another copy takes over: `agy models` in a container (a pod
// on Kubernetes) the runner starts, its agent installed first. The runner starts none with too
// little of it left, and ends its Kubernetes pod within it; Docker's container has no time
// limit (../lib/services.mjs LOGIN_REFRESH_MS, ../runner/service.mjs loginRefresh()).
export const REFRESH_MS = LOGIN_REFRESH_MS;
// How often a copy waiting for another's refresh looks at the store.
const WAIT_EVERY_MS = 500;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// The key the logins are sealed with, a file in `dir` (models.key, owner-only): made once, when
// there is none. Every copy needs the same one (one volume, or one Secret on Kubernetes). A new
// key (or another store) leaves the stored logins unreadable, and each starts again from its
// file, whose refresh token the first refresh spent: the ChatGPT plan's needs a new sign-in then
// (docs/guides/services.md, The models service).
export function loginKey(dir, { beforeLink = () => {} } = {}) {
  const path = join(dir, "models.key");
  const read = () => {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (key.length === 32) return key;
    throw new Error(`${path} isn't a key: remove it, and a new one is made`);
  };
  try {
    return read();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // Written whole aside, then linked in place only if there is still none: two copies starting
  // together on an empty volume keep the one that got there first, and read it. `beforeLink()`:
  // the tests' other copy, getting there first.
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
  try {
    beforeLink();
    linkSync(tmp, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
  return read();
}

// `kid`: which key it is (a hash of something derived from it, nothing of the key), stored with
// each sealed login: a copy with another key says so rather than take the login for none.
export const loginSeal = (key) => ({
  ...sealWith(key, "models logins"),
  kid: Buffer.from(hkdfSync("sha256", key, "deckhand", "models key id", 8)).toString("hex"),
});

// A login sealed with another models.key than this copy's: every copy needs the same one.
class KeyMismatch extends Error {}

// The credentials' fingerprints' salt (http.mjs fingerprints()), from the same key: every copy
// has it, and it outlives a restart. Not secret (the listener holds it), and nothing of the key.
export const fingerprintSalt = (key) =>
  Buffer.from(hkdfSync("sha256", key, "deckhand", "models fingerprints salt", 16)).toString("hex");

// Unusable until the operator acts: 401, a bad credential, for a fallback (agents/
// providerError()). `refused`: an expired, reused or revoked refresh token, which signing in
// again fixes; else the file is the problem (upstream.mjs credentialFailure()).
export class LoginError extends Error {
  status = 401;
  constructor(message, { refused = false } = {}) {
    super(message);
    this.refused = refused;
  }
}

// The login `name` ("chatgpt", "antigravity") of `file` in `store`, sealed with `seal`
// (loginSeal()'s). `parse(text)`: the file's login, or a LoginError naming it. `holder`: this
// copy's name, for the refresh's lease. → { load, refresh }.
function sharedLogin({
  store,
  seal,
  name,
  file,
  parse,
  holder = randomBytes(6).toString("hex"),
  refreshMs = REFRESH_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const key = `login:${name}`;
  const lease = `login:${name}:refresh`;
  let read = null; // { mtimeMs, seed }: the file as last read

  // The file's hash: read again when it changed on disk. Its text never leaves this function
  // but through parse().
  async function seedOf() {
    const { mtimeMs } = await stat(file);
    if (read?.mtimeMs === mtimeMs) return { seed: read.seed, text: null };
    const text = await readFile(file, "utf8");
    read = { mtimeMs, seed: sha256(text) };
    return { seed: read.seed, text };
  }

  // The store's value, { kid, sealed }, opened; null when there is none. Sealed with another key
  // (a copy whose models.key isn't this one's): refused, never written over, which would put the
  // file's spent login in place of the other copy's refreshed one.
  const opened = (raw) => {
    if (raw === null) return null;
    if (raw?.kid !== seal.kid) {
      throw new KeyMismatch(
        `the ${name} login in the store is sealed with another models.key than this copy's: every copy of the models service needs the same one (docs/guides/services.md, The models service)`,
      );
    }
    const text = seal.open(raw.sealed);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };

  // → { seed, login, broken, raw }: the store's login, or the file's when it is a new sign-in
  // (or the store has none). `broken`: { message, refused } once a refresh was refused, until
  // the file changes.
  async function load() {
    for (;;) {
      let { seed, text } = await seedOf();
      const raw = await store.get(key);
      const saved = opened(raw);
      if (saved?.seed === seed) return { ...saved, raw };
      // Not read just now (the same mtime): read for its login.
      text ??= await readFile(file, "utf8");
      seed = sha256(text);
      const fresh = { seed, login: parse(text), broken: null };
      const sealed = { kid: seal.kid, sealed: seal.seal(JSON.stringify(fresh)) };
      // Another copy's refresh meanwhile: read again, rather than write a spent login over it.
      if (await store.compareAndSet(key, raw, sealed)) return { ...fresh, raw: sealed };
    }
  }

  // Saved over `before` (load()'s), unless another copy changed it meanwhile.
  async function save(before, next) {
    const sealed = {
      kid: seal.kid,
      sealed: seal.seal(JSON.stringify({ seed: before.seed, ...next })),
    };
    return store.compareAndSet(key, before.raw, sealed);
  }

  const same = (a, b) =>
    JSON.stringify(a.login) === JSON.stringify(b.login) && !a.broken === !b.broken;

  // `saved`, refreshed by `run(login, { until })` → the new login, once for every copy: the
  // lease's holder runs it, and saves its result; the others wait for it. `until`: when the
  // lease runs out (this copy's clock), which the refresh must end before: another copy takes
  // the login over then. A refusal (an error with
  // `refused`, a LoginError) is saved too, so that no copy spends the login again. → load()'s.
  async function refresh(saved, run, rounds = 2) {
    // Taken before asking, so that the lease's true end is never later than this.
    const until = now() + refreshMs;
    const held = await store.acquire(lease, holder, { ttlMs: refreshMs });
    if (!held) return waitFor(saved, run, rounds);
    try {
      const latest = await load();
      // Another copy's done already.
      if (!same(latest, saved)) return latest;
      let next;
      try {
        next = await run(latest.login, { until });
      } catch (error) {
        if (error.status === 401) {
          await save(latest, {
            login: latest.login,
            broken: { message: error.message, refused: error.refused === true },
          });
        }
        throw error;
      }
      if (!(await save(latest, { login: next, broken: null }))) {
        // A new sign-in replaced the file meanwhile: that one wins, this refresh is lost.
        return load();
      }
      return { seed: latest.seed, login: next, broken: null };
    } finally {
      await store.release(lease, holder, held.epoch).catch(() => false);
    }
  }

  // Another copy refreshes: its result, once saved. Its lease gone with nothing new (it failed,
  // or stopped): this copy tries itself, `rounds` times at most.
  async function waitFor(saved, run, rounds) {
    const until = now() + refreshMs;
    while (now() < until) {
      await sleep(WAIT_EVERY_MS);
      const latest = await load();
      if (!same(latest, saved)) return latest;
      if (!(await store.lease(lease))) {
        if (rounds > 1) return refresh(saved, run, rounds - 1);
        throw new Error(`the ${name} login's refresh, by another copy, ended without one`);
      }
    }
    throw new Error(`the ${name} login's refresh, by another copy, didn't end`);
  }

  return { load, refresh };
}

// A plan's login as its endpoint uses it (chatgpt.mjs, antigravity-login.mjs): sharedLogin()'s,
// with what differs between plans. `due(login)`: whether it needs a refresh now;
// `refresh(login, { until })` → the new login, before `until` (the lease's end,
// sharedLogin()); `headersOf(login)`: the headers that make a call the plan's;
// `accessOf(login)`: its access token; `secretsOf(login)`: its tokens; `refreshed(error)`: each
// refresh this copy did, once over (its metrics), the error when it failed. → { headers,
// current, refused, secrets }.
export function planLogin({
  due,
  refresh,
  headersOf,
  accessOf,
  secretsOf,
  refreshed = () => {},
  ...options
}) {
  const shared = sharedLogin(options);
  // Counted where it runs: in the copy holding the lease, once for every copy.
  const counted = (login, options) =>
    refresh(login, options).then(
      (next) => (refreshed(null), next),
      (error) => {
        refreshed(error);
        throw error;
      },
    );
  let last = null; // the login as last used, for refused() and secrets()
  let stale = null; // an access token the upstream refused: refreshed on the next call
  // One refresh at a time in this copy too: every caller awaits it.
  let refreshing = null;

  const usable = (saved) => {
    last = saved.login;
    if (saved.broken) throw new LoginError(saved.broken.message, saved.broken);
    return saved;
  };

  // The headers that make a call the plan's. Throws when there is no usable login.
  async function headers() {
    let saved = usable(await shared.load());
    if (accessOf(saved.login) === stale || due(saved.login)) {
      refreshing ??= shared.refresh(saved, counted).finally(() => (refreshing = null));
      saved = usable(await refreshing);
      stale = null;
    }
    return headersOf(saved.login);
  }

  // The headers, unless the login is due for a refresh (or unusable): null then, nothing
  // refreshed. For the usage polls (usage.mjs), which an idle dashboard makes.
  async function current() {
    const saved = await shared.load();
    if (saved.broken || accessOf(saved.login) === stale || due(saved.login)) return null;
    last = saved.login;
    return headersOf(saved.login);
  }

  // The upstream refused this access token (401): the next call refreshes it first, once.
  function refused(authorization) {
    const token = String(authorization).replace(/^Bearer /, "");
    if (last && token === accessOf(last)) stale = token;
  }

  // Its tokens as last used: redacted from runs' output like the other credentials, though no
  // sandbox has them (http.mjs fingerprints).
  const secrets = () => (last ? secretsOf(last) : []);

  return { headers, current, refused, secrets };
}
