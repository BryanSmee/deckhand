// A Redis client, the few commands the store's Redis backend sends (store-redis.mjs), over
// node:net or node:tls: RESP2, pipelined, no package (#509). Replies come back in the order the
// commands went: each call waits for its own. A connection that drops fails the calls in flight;
// the next call opens another, authenticated and on its database again.
import { isIP, connect as tcp } from "node:net";
import { connect as tls } from "node:tls";

export class RedisError extends Error {}

// `redis://[user:password@]host[:port][/db]`, `rediss://` over TLS. The password may be left
// out of the URL and passed as `password` instead (REDIS_PASSWORD).
export function parseRedisUrl(url, { password } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new TypeError(`not a Redis URL: ${parsed.protocol}`);
  }
  const db = parsed.pathname.replace(/^\//, "");
  const user = decodeURIComponent(parsed.username) || null;
  password ||= decodeURIComponent(parsed.password) || null;
  // A user without a password would send no AUTH, and fail later on NOAUTH: say it now.
  if (user && !password) throw new TypeError(`Redis user ${user}: no password (REDIS_PASSWORD)`);
  if (db && !/^\d+$/.test(db)) throw new TypeError(`a Redis database is a number, not ${db}`);
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, "") || "localhost",
    port: Number(parsed.port) || 6379,
    tls: parsed.protocol === "rediss:",
    user,
    password,
    db: db ? Number(db) : 0,
  };
}

// A command as RESP: an array of bulk strings, Buffers kept as they are.
export function encode(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const data = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg));
    parts.push(Buffer.from(`$${data.length}\r\n`), data, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

// Replies out of the chunks a socket gets: feed() it what arrives, each whole reply goes to
// `onReply`. Bulk strings come back as Buffers (blobs are bytes), errors as RedisError values.
// It reads as the bytes come, one element at a time, keeping the arrays under way: what is read
// is never read again, and chunks are only joined once there are enough of them for the element
// under way. A large blob, or a long array (a stream read), is copied once, not once per chunk.
// A reply it can't read throws (not Redis on that port: the client then drops the connection).
export function replyParser(onReply) {
  let buffer = Buffer.alloc(0); // bytes not read yet
  let chunks = [];
  let received = 0; // bytes in `buffer` and `chunks`
  let need = 0; // bytes the element under way needs before it is worth reading again
  const arrays = []; // the arrays under way, innermost last: { items, count }

  // An element read, into the array under way, or out as a reply once it is whole.
  function done(value) {
    for (;;) {
      const array = arrays.at(-1);
      if (!array) return onReply(value);
      array.items.push(value);
      if (array.items.length < array.count) return;
      arrays.pop();
      value = array.items;
    }
  }

  // One element from `at`: the offset past it, or -1 with `need` set when it isn't whole yet.
  function element(at) {
    const end = buffer.indexOf("\r\n", at);
    if (end < 0) {
      need = buffer.length - at + 1;
      return -1;
    }
    const type = String.fromCharCode(buffer[at]);
    const line = buffer.toString("utf8", at + 1, end);
    const next = end + 2;
    switch (type) {
      case "+":
        done(line);
        return next;
      case "-":
        done(new RedisError(line));
        return next;
      case ":":
        done(Number(line));
        return next;
      case "$": {
        const length = Number(line);
        if (!Number.isInteger(length)) throw new RedisError(`not a length: ${line}`);
        if (length < 0) {
          done(null);
          return next;
        }
        if (buffer.length < next + length + 2) {
          need = next + length + 2 - at;
          return -1;
        }
        done(Buffer.from(buffer.subarray(next, next + length)));
        return next + length + 2;
      }
      case "*": {
        const count = Number(line);
        if (!Number.isInteger(count)) throw new RedisError(`not a count: ${line}`);
        if (count < 0) done(null);
        else if (count === 0) done([]);
        else arrays.push({ items: [], count });
        return next;
      }
      default:
        throw new RedisError(`not a Redis reply (it starts with ${JSON.stringify(type)})`);
    }
  }

  return function feed(chunk) {
    chunks.push(chunk);
    received += chunk.length;
    if (received < need) return;
    buffer = chunks.length === 1 && !buffer.length ? chunk : Buffer.concat([buffer, ...chunks]);
    chunks = [];
    need = 0;
    let at = 0;
    while (at < buffer.length) {
      const next = element(at);
      if (next < 0) break;
      at = next;
    }
    buffer = buffer.subarray(at);
    received = buffer.length;
  };
}

// A client: `call(...args)` → the reply (a RedisError reply rejects), `close()`. `connect`: a
// function returning a socket (the tests' fake server), else the URL's host and port.
// `timeoutMs`: how long a call waits for its reply. Across nodes, a Redis that moved or a
// network cut leaves a connection open that nothing answers on: past it, the call fails and the
// connection is dropped, so that a lease holder learns it can't renew in time rather than in
// minutes, and the next call connects again.
export function redisClient(url, { password, connect, timeoutMs = 5000 } = {}) {
  const options = parseRedisUrl(url, { password });
  let socket = null;
  let ready = null; // resolves once the socket is authenticated and on its database
  let pending = []; // { resolve, reject, timer } per command sent, in order
  let closed = false;

  // Fails the calls waiting on `opened`, and drops it.
  function fail(opened, error) {
    if (socket !== opened) return;
    socket = null;
    ready = null;
    const lost = pending;
    pending = [];
    const reason = error ?? new RedisError("the connection to Redis closed");
    for (const waiting of lost) waiting.reject(reason);
    opened.destroy();
  }

  function open() {
    const opened = connect
      ? connect(options)
      : options.tls
        ? tls({
            host: options.host,
            port: options.port,
            // SNI takes a name, never an address (RFC 6066). A private CA is trusted through
            // NODE_EXTRA_CA_CERTS.
            ...(isIP(options.host) ? {} : { servername: options.host }),
          })
        : tcp({ host: options.host, port: options.port });
    opened.setNoDelay?.(true);
    // Probes an idle connection, so that one cut while nothing is asked is noticed too.
    opened.setKeepAlive?.(true, 10_000);
    const feed = replyParser((reply) => {
      const waiting = pending.shift();
      if (!waiting) return;
      if (reply instanceof RedisError) waiting.reject(reply);
      else waiting.resolve(reply);
    });
    opened.on("data", (chunk) => {
      try {
        feed(chunk);
      } catch (error) {
        fail(opened, error instanceof RedisError ? error : new RedisError(error.message));
      }
    });
    opened.on("error", (error) => fail(opened, error));
    opened.on("close", () => fail(opened, null));
    socket = opened;

    const hello = [];
    if (options.password) {
      hello.push(
        options.user ? ["AUTH", options.user, options.password] : ["AUTH", options.password],
      );
    }
    if (options.db) hello.push(["SELECT", options.db]);
    ready = Promise.all(hello.map((args) => send(opened, args))).then(() => opened);
    // Refused (a wrong password): its failure reaches the calls waiting on it, and the next call
    // opens another connection rather than wait on this one.
    ready.catch((error) => fail(opened, error));
    return ready;
  }

  function send(to, args) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => fail(to, new RedisError(`Redis didn't answer within ${timeoutMs} ms`)),
        timeoutMs,
      );
      timer.unref?.();
      const done = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      pending.push({ resolve: done(resolve), reject: done(reject) });
      to.write(encode(args));
    });
  }

  async function call(...args) {
    if (closed) throw new RedisError("the Redis client is closed");
    const to = await (ready ?? open());
    return send(to, args);
  }

  async function close() {
    closed = true;
    const to = socket;
    if (!to) return;
    try {
      await send(to, ["QUIT"]);
    } catch {
      // Gone already.
    }
    to.destroy();
  }

  return { call, close };
}
