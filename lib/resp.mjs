// A Redis client, the few commands the store's Redis backend sends (store-redis.mjs), over
// node:net or node:tls: RESP2, pipelined, no package (#509). Replies come back in the order the
// commands went: each call waits for its own. A connection that drops fails the calls in flight;
// the next call opens another, authenticated and on its database again.
import { connect as tcp } from "node:net";
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
  if (db && !/^\d+$/.test(db)) throw new TypeError(`a Redis database is a number, not ${db}`);
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, "") || "localhost",
    port: Number(parsed.port) || 6379,
    tls: parsed.protocol === "rediss:",
    user: decodeURIComponent(parsed.username) || null,
    password: password || decodeURIComponent(parsed.password) || null,
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

// Replies out of a growing buffer: feed() it what arrives, each whole reply goes to `onReply`.
// Bulk strings come back as Buffers (blobs are bytes), errors as RedisError values.
export function replyParser(onReply) {
  let buffer = Buffer.alloc(0);
  const NEED_MORE = Symbol("more");

  // One reply from `at`: [value, next offset], or NEED_MORE.
  function parse(at) {
    const end = buffer.indexOf("\r\n", at);
    if (end < 0) return NEED_MORE;
    const type = String.fromCharCode(buffer[at]);
    const line = buffer.toString("utf8", at + 1, end);
    const next = end + 2;
    switch (type) {
      case "+":
        return [line, next];
      case "-":
        return [new RedisError(line), next];
      case ":":
        return [Number(line), next];
      case "$": {
        const length = Number(line);
        if (length < 0) return [null, next];
        if (buffer.length < next + length + 2) return NEED_MORE;
        return [Buffer.from(buffer.subarray(next, next + length)), next + length + 2];
      }
      case "*": {
        const count = Number(line);
        if (count < 0) return [null, next];
        const items = [];
        let offset = next;
        for (let i = 0; i < count; i++) {
          const item = parse(offset);
          if (item === NEED_MORE) return NEED_MORE;
          items.push(item[0]);
          offset = item[1];
        }
        return [items, offset];
      }
      default:
        throw new RedisError(`unexpected reply type ${JSON.stringify(type)}`);
    }
  }

  return function feed(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    let at = 0;
    while (at < buffer.length) {
      const reply = parse(at);
      if (reply === NEED_MORE) break;
      at = reply[1];
      onReply(reply[0]);
    }
    buffer = buffer.subarray(at);
  };
}

// A client: `call(...args)` → the reply (a RedisError reply rejects), `close()`. `connect`: a
// function returning a socket (the tests' fake server), else the URL's host and port.
export function redisClient(url, { password, connect } = {}) {
  const options = parseRedisUrl(url, { password });
  let socket = null;
  let ready = null; // resolves once the socket is authenticated and on its database
  let pending = []; // { resolve, reject } per command sent, in order
  let closed = false;

  function open() {
    const opened = connect
      ? connect(options)
      : options.tls
        ? tls({ host: options.host, port: options.port, servername: options.host })
        : tcp({ host: options.host, port: options.port });
    opened.setNoDelay?.(true);
    const feed = replyParser((reply) => {
      const waiting = pending.shift();
      if (!waiting) return;
      if (reply instanceof RedisError) waiting.reject(reply);
      else waiting.resolve(reply);
    });
    opened.on("data", feed);
    const fail = (error) => {
      if (socket !== opened) return;
      socket = null;
      ready = null;
      const lost = pending;
      pending = [];
      const reason = error ?? new RedisError("the connection to Redis closed");
      for (const waiting of lost) waiting.reject(reason);
    };
    opened.on("error", fail);
    opened.on("close", () => fail(null));
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
    ready.catch((error) => {
      fail(error);
      opened.destroy();
    });
    return ready;
  }

  function send(to, args) {
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
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
