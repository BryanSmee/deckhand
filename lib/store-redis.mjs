// The store's Redis backend (store.mjs has the interface), for two copies of a service on
// several nodes (#509): whatever node they run on, they reach the same Redis. Each call is one
// Lua script, atomic in Redis as the file backend's mutex makes its calls, so two copies racing
// for a key, a lease or an event get the answers one process would give.
//
// Keys, under `prefix`: `k:<key>` a hash { v: the JSON value, e: when it expires }, `l:<name>` a
// lease's hash { holder, epoch, expiresAt }, kept once released for its epoch, `s:<stream>` a
// Redis stream, one consumer group per consumer, and `n:<stream>` the counter its ids come from,
// `b:<key>` a blob. Not for Redis Cluster: a stream's two keys would need a hash tag.
//
// The clock is Redis's own (TIME, in the scripts): copies on nodes whose clocks drift apart still
// agree on when a key or a lease expires. `now` replaces it in the tests, which move time on;
// the keys then don't expire in Redis itself, only to the scripts.
import { createHash } from "node:crypto";
import { RedisError, redisClient } from "./resp.mjs";

// What every script starts with: the time, and a key's value while it lasts.
const PRELUDE = `
local function clock(given)
  if given ~= '' then return tonumber(given), false end
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000), true
end
local function num(n) return string.format('%.0f', n) end
local function live(key, now)
  local h = redis.call('HMGET', key, 'v', 'e')
  if not h[1] then return nil end
  if h[2] and tonumber(h[2]) <= now then
    redis.call('DEL', key)
    return nil
  end
  return h[1]
end
local function put(key, value, ttl, now, real)
  redis.call('DEL', key)
  if ttl == '' then
    redis.call('HSET', key, 'v', value)
  else
    local e = now + tonumber(ttl)
    redis.call('HSET', key, 'v', value, 'e', num(e))
    if real then redis.call('PEXPIREAT', key, num(e)) end
  end
end
local function holding(key, now)
  local h = redis.call('HMGET', key, 'holder', 'epoch', 'expiresAt')
  local held = h[1] and h[1] ~= '' and tonumber(h[3]) > now
  return held, h[1], tonumber(h[2] or '0'), tonumber(h[3] or '0')
end
`;

// KEYS and ARGV per script; ARGV[1] is always the clock ('' for Redis's).
const SCRIPTS = {
  get: `local now = clock(ARGV[1]) return live(KEYS[1], now) or false`,
  // ARGV: now, value, ttl
  set: `local now, real = clock(ARGV[1]) put(KEYS[1], ARGV[2], ARGV[3], now, real) return 1`,
  delete: `
    local now = clock(ARGV[1])
    local had = live(KEYS[1], now)
    redis.call('DEL', KEYS[1])
    return had and 1 or 0`,
  setIfAbsent: `
    local now, real = clock(ARGV[1])
    if live(KEYS[1], now) then return 0 end
    put(KEYS[1], ARGV[2], ARGV[3], now, real)
    return 1`,
  // ARGV: now, value, ttl, the value expected as JSON ('null': none)
  compareAndSet: `
    local now, real = clock(ARGV[1])
    if (live(KEYS[1], now) or 'null') ~= ARGV[4] then return 0 end
    put(KEYS[1], ARGV[2], ARGV[3], now, real)
    return 1`,
  // ARGV: now, by, ttl. The number back as text: Lua's doubles, as JSON's.
  increment: `
    local now, real = clock(ARGV[1])
    local found = live(KEYS[1], now)
    local by = tonumber(ARGV[2])
    if not found then
      put(KEYS[1], ARGV[2], ARGV[3], now, real)
      return ARGV[2]
    end
    local n = tonumber(found)
    if not n or not string.match(found, '^%-?%d') then return redis.error_reply('NOTANUMBER') end
    local value = string.format('%.17g', n + by)
    redis.call('HSET', KEYS[1], 'v', value)
    return value`,

  // ARGV: now, holder, ttl
  acquire: `
    local now = clock(ARGV[1])
    local held, holder, epoch = holding(KEYS[1], now)
    if held and holder ~= ARGV[2] then return false end
    if not held then epoch = epoch + 1 end
    local e = now + tonumber(ARGV[3])
    redis.call('HSET', KEYS[1], 'holder', ARGV[2], 'epoch', num(epoch), 'expiresAt', num(e))
    return { ARGV[2], epoch, e }`,
  // ARGV: now, holder, epoch, ttl
  renew: `
    local now = clock(ARGV[1])
    local held, holder, epoch = holding(KEYS[1], now)
    if not held or holder ~= ARGV[2] or epoch ~= tonumber(ARGV[3]) then return false end
    local e = now + tonumber(ARGV[4])
    redis.call('HSET', KEYS[1], 'expiresAt', num(e))
    return { holder, epoch, e }`,
  // ARGV: now, holder, epoch
  release: `
    local now = clock(ARGV[1])
    local held, holder, epoch = holding(KEYS[1], now)
    if not held or holder ~= ARGV[2] or epoch ~= tonumber(ARGV[3]) then return 0 end
    redis.call('HSET', KEYS[1], 'holder', '', 'expiresAt', '0')
    return 1`,
  lease: `
    local now = clock(ARGV[1])
    local held, holder, epoch, e = holding(KEYS[1], now)
    if not held then return false end
    return { holder, epoch, e }`,

  // KEYS: the stream, its counter. ARGV: now, the event as JSON, maxLength ('': all). Ids from
  // the counter, '<n>-0': numbers that keep increasing, as the file backend's.
  append: `
    local n = redis.call('INCR', KEYS[2])
    local id = num(n) .. '-0'
    if ARGV[3] == '' then
      redis.call('XADD', KEYS[1], id, 'e', ARGV[2])
    else
      redis.call('XADD', KEYS[1], 'MAXLEN', ARGV[3], id, 'e', ARGV[2])
    end
    return n`,
  // ARGV: now, the consumer (its group), count. What the group's one reader has pending first
  // (read, not acknowledged), then new events: [id, event, id, event…]. Pending events trimmed
  // away by maxLength since are acknowledged, as there is nothing left to handle.
  read: `
    local group, count = ARGV[2], tonumber(ARGV[3])
    redis.pcall('XGROUP', 'CREATE', KEYS[1], group, '0', 'MKSTREAM')
    local out = {}
    local function take(from, max)
      local r = redis.call('XREADGROUP', 'GROUP', group, 'reader', 'COUNT', max, 'STREAMS', KEYS[1], from)
      if not r or not r[1] then return {} end
      return r[1][2]
    end
    local from = '0'
    while #out < 2 * count do
      local want = count - #out / 2
      local entries = take(from, want)
      for _, entry in ipairs(entries) do
        if entry[2] then
          table.insert(out, entry[1])
          table.insert(out, entry[2][2])
        else
          redis.call('XACK', KEYS[1], group, entry[1])
        end
        from = entry[1]
      end
      if #entries < want then break end
    end
    if #out < 2 * count then
      for _, entry in ipairs(take('>', count - #out / 2)) do
        table.insert(out, entry[1])
        table.insert(out, entry[2][2])
      end
    end
    return out`,

  readBlob: `
    if redis.call('EXISTS', KEYS[1]) == 0 then return false end
    return redis.call('GETRANGE', KEYS[1], ARGV[2], -1)`,
};

// A stream's or a blob's name: some text, as in the file backend.
function named(name) {
  if (typeof name !== "string" || !name) throw new TypeError(`not a name: ${JSON.stringify(name)}`);
  return name;
}

// A lease's lifetime, as in the file backend: without one, two holders would both think they
// hold it.
function leaseTtl(ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError(`a lease's ttlMs: a positive number, not ${ttlMs}`);
  }
  return ttlMs;
}

function json(key, value) {
  if (value === undefined) throw new TypeError(`${key}: undefined isn't a value`);
  return JSON.stringify(value);
}
const ttl = (ttlMs) => (ttlMs ? String(Math.ceil(ttlMs)) : "");
const parsed = (reply) => (reply === null ? null : JSON.parse(reply.toString()));
const lease = (reply) =>
  reply && { holder: reply[0].toString(), epoch: reply[1], expiresAt: reply[2] };
// Stream ids: `<n>-0` in Redis, `<n>` out of the store.
const streamId = (id) => `${Number(id)}-0`;

// `url`: redis:// or rediss:// (resp.mjs). `prefix`: before every key, so that several
// deployments, or tests, can share one Redis. `client`: the tests' own.
export function redisStore({
  url,
  password,
  prefix = "deckhand:",
  now = null,
  client = redisClient(url, { password }),
} = {}) {
  const shas = Object.fromEntries(
    Object.entries(SCRIPTS).map(([name, body]) => {
      const source = PRELUDE + body;
      return [name, { source, sha: createHash("sha1").update(source).digest("hex") }];
    }),
  );

  // The script by its hash, sent whole the first time a Redis doesn't know it (just started,
  // SCRIPT FLUSH).
  async function run(name, keys, args) {
    const { source, sha } = shas[name];
    const clock = now ? String(now()) : "";
    const tail = [keys.length, ...keys, clock, ...args];
    try {
      return await client.call("EVALSHA", sha, ...tail);
    } catch (error) {
      if (!(error instanceof RedisError) || !error.message.startsWith("NOSCRIPT")) throw error;
      return client.call("EVAL", source, ...tail);
    }
  }

  const k = (key) => `${prefix}k:${key}`;
  const l = (name) => `${prefix}l:${name}`;
  const s = (name) => `${prefix}s:${named(name)}`;
  const n = (name) => `${prefix}n:${named(name)}`;
  const b = (key) => `${prefix}b:${named(key)}`;

  return {
    get: async (key) => parsed(await run("get", [k(key)], [])),
    set: async (key, value, { ttlMs } = {}) => {
      await run("set", [k(key)], [json(key, value), ttl(ttlMs)]);
    },
    delete: async (key) => (await run("delete", [k(key)], [])) === 1,
    setIfAbsent: async (key, value, { ttlMs } = {}) =>
      (await run("setIfAbsent", [k(key)], [json(key, value), ttl(ttlMs)])) === 1,
    compareAndSet: async (key, expected, value, { ttlMs } = {}) =>
      (await run(
        "compareAndSet",
        [k(key)],
        [json(key, value), ttl(ttlMs), JSON.stringify(expected ?? null)],
      )) === 1,
    increment: async (key, by = 1, { ttlMs } = {}) => {
      if (!Number.isFinite(by)) throw new TypeError(`${key}: increment by a number, not ${by}`);
      try {
        return Number((await run("increment", [k(key)], [String(by), ttl(ttlMs)])).toString());
      } catch (error) {
        if (/\bNOTANUMBER$/.test(error.message)) throw new TypeError(`${key} isn't a number`);
        throw error;
      }
    },

    acquire: async (name, holder, { ttlMs } = {}) =>
      lease(await run("acquire", [l(name)], [named(holder), ttl(leaseTtl(ttlMs))])),
    renew: async (name, holder, epoch, { ttlMs } = {}) =>
      lease(await run("renew", [l(name)], [holder, epoch, ttl(leaseTtl(ttlMs))])),
    release: async (name, holder, epoch) =>
      (await run("release", [l(name)], [holder, epoch])) === 1,
    lease: async (name) => lease(await run("lease", [l(name)], [])),

    append: async (name, event, { maxLength } = {}) =>
      String(
        await run(
          "append",
          [s(name), n(name)],
          [json(name, event), maxLength ? String(Math.floor(maxLength)) : ""],
        ),
      ),
    read: async (name, consumer, { count = 100 } = {}) => {
      const flat = await run("read", [s(name)], [named(consumer), String(count)]);
      const out = [];
      for (let i = 0; i < flat.length; i += 2) {
        out.push({ id: flat[i].toString().replace(/-0$/, ""), event: parsed(flat[i + 1]) });
      }
      return out;
    },
    ack: async (name, consumer, ids) => {
      const key = s(name);
      named(consumer);
      const valid = ids.filter((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0);
      if (!valid.length) return 0;
      return client.call("XACK", key, consumer, ...new Set(valid.map(streamId)));
    },

    putBlob: async (key, data) => {
      await client.call("SET", b(key), data);
    },
    appendBlob: async (key, data) => {
      await client.call("APPEND", b(key), data);
    },
    readBlob: async (key, { offset = 0 } = {}) =>
      run("readBlob", [b(key)], [String(Math.max(0, Math.floor(offset)))]),
    deleteBlob: async (key) => (await client.call("DEL", b(key))) === 1,

    close: () => client.close(),
  };
}
