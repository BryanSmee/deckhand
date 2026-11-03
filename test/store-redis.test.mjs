// The store's Redis backend (lib/store-redis.mjs) and its client (lib/resp.mjs): the client
// against a fake server, then the shared suite and two copies of a service against a real Redis,
// when there is one: TEST_REDIS_URL (`redis://engine:6379` with the engine), else `redis-server`
// on the PATH, started for this file. Neither: those tests skip.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import { encode, parseRedisUrl, RedisError, redisClient, replyParser } from "../lib/resp.mjs";
import { openStore, values } from "../lib/store.mjs";
import { redisStore } from "../lib/store-redis.mjs";
import { asidePort, listening, until } from "./helpers.mjs";
import { storeContract } from "./store-contract.mjs";

test("resp: commands encoded as bulk strings, bytes kept", () => {
  assert.equal(
    encode(["SET", "k", Buffer.from([0, 255]), 12]).toString("latin1"),
    "*4\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\n\x00\xff\r\n$2\r\n12\r\n",
  );
});

test("resp: replies parsed whatever the chunks they arrive in", () => {
  const replies = [];
  const feed = replyParser((reply) => replies.push(reply));
  const wire = Buffer.from(
    "+OK\r\n-ERR wrong\r\n:42\r\n$-1\r\n$5\r\na\r\nbc\r\n*2\r\n*1\r\n:1\r\n$0\r\n\r\n*-1\r\n",
  );
  // A byte at a time: nothing comes out before its reply is whole.
  for (let i = 0; i < wire.length; i++) feed(wire.subarray(i, i + 1));
  assert.equal(replies[0], "OK");
  assert.ok(replies[1] instanceof RedisError);
  assert.equal(replies[1].message, "ERR wrong");
  assert.equal(replies[2], 42);
  assert.equal(replies[3], null);
  assert.deepEqual(replies[4], Buffer.from("a\r\nbc"));
  assert.deepEqual(replies[5], [[1], Buffer.alloc(0)]);
  assert.equal(replies[6], null);
  assert.equal(replies.length, 7);
});

// The bytes Buffer.concat() copies while `wire` is fed in `size`-byte chunks, and the replies.
function feedInChunks(wire, size) {
  const replies = [];
  const feed = replyParser((reply) => replies.push(reply));
  const concat = Buffer.concat;
  let copied = 0;
  Buffer.concat = (list, ...rest) => {
    const joined = concat(list, ...rest);
    copied += joined.length;
    return joined;
  };
  try {
    for (let i = 0; i < wire.length; i += size) feed(wire.subarray(i, i + size));
  } finally {
    Buffer.concat = concat;
  }
  return { replies, copied };
}

test("resp: a large reply in many chunks is joined once", () => {
  const body = Buffer.alloc(4 * 1024 * 1024, 7);
  const wire = Buffer.concat([Buffer.from(`$${body.length}\r\n`), body, Buffer.from("\r\n:1\r\n")]);
  const { replies, copied } = feedInChunks(wire, 16 * 1024);
  assert.deepEqual(replies, [body, 1]);
  assert.ok(copied < 2 * wire.length, `${copied} bytes copied for ${wire.length}`);
});

test("resp: a long array (a stream read) is read once, not again per chunk", () => {
  // 200 elements of 16 KB in an array of id and event pairs, as the read script answers.
  const events = Array.from({ length: 200 }, (_, i) => Buffer.alloc(16 * 1024, i));
  const parts = [Buffer.from(`*${events.length * 2}\r\n`)];
  events.forEach((event, i) => {
    parts.push(Buffer.from(`$${String(i).length + 2}\r\n${i}-0\r\n$${event.length}\r\n`));
    parts.push(event, Buffer.from("\r\n"));
  });
  parts.push(Buffer.from(":7\r\n+OK\r\n"));
  const wire = Buffer.concat(parts);
  const array = events.flatMap((event, i) => [Buffer.from(`${i}-0`), event]);
  for (const size of [16 * 1024, 10_000, 7]) {
    const { replies, copied } = feedInChunks(wire, size);
    assert.deepEqual(replies, [array, 7, "OK"], `chunks of ${size}`);
    assert.ok(
      copied < 2 * wire.length,
      `chunks of ${size}: ${copied} bytes copied for ${wire.length}`,
    );
  }
});

test("resp: what isn't a Redis reply throws", () => {
  const feed = replyParser(() => {});
  assert.throws(() => feed(Buffer.from("HTTP/1.1 400 Bad Request\r\n")), /not a Redis reply/);
});

test("resp: Redis URLs", () => {
  assert.deepEqual(parseRedisUrl("redis://store"), {
    host: "store",
    port: 6379,
    tls: false,
    user: null,
    password: null,
    db: 0,
  });
  assert.deepEqual(parseRedisUrl("rediss://deckhand:p%40ss@store:6380/2"), {
    host: "store",
    port: 6380,
    tls: true,
    user: "deckhand",
    password: "p@ss",
    db: 2,
  });
  assert.equal(parseRedisUrl("redis://store", { password: "env" }).password, "env");
  assert.throws(() => parseRedisUrl("redis://store/x"), /a number/);
  // A user without a password would send no AUTH, and fail later on NOAUTH.
  assert.throws(() => parseRedisUrl("redis://deckhand@store"), /no password/);
  assert.equal(parseRedisUrl("redis://deckhand@store", { password: "env" }).user, "deckhand");
  assert.throws(() => parseRedisUrl("http://store"), /not a Redis URL/);
});

// A fake Redis: `answer(args)` → the reply's RESP text, per command; every command it got, as
// text, in `got`. `drop`: the connections, to close.
async function fakeRedis(t, answer) {
  const got = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on(
      "data",
      replyParser((args) => {
        const command = args.map(String);
        got.push(command);
        const reply = answer(command);
        if (reply !== undefined) socket.write(reply);
      }),
    );
  });
  const port = await listening(server);
  server.unref();
  t.after(() => server.close());
  const drop = () => {
    for (const socket of sockets) socket.destroy();
  };
  return { url: `redis://127.0.0.1:${port}`, got, drop };
}

test("resp: authenticates and picks its database first, then pipelines in order", async (t) => {
  const redis = await fakeRedis(t, ([name, ...args]) => {
    if (name === "AUTH" || name === "SELECT") return "+OK\r\n";
    if (name === "ECHO") return `$${args[0].length}\r\n${args[0]}\r\n`;
    if (name === "QUIT") return "+OK\r\n";
    return "-ERR unknown\r\n";
  });
  const url = redis.url.replace("//", "//user:secret@") + "/3";
  const client = redisClient(url);
  t.after(() => client.close());
  const replies = await Promise.all(["a", "b", "c"].map((s) => client.call("ECHO", s)));
  assert.deepEqual(replies.map(String), ["a", "b", "c"]);
  assert.deepEqual(redis.got.slice(0, 2), [
    ["AUTH", "user", "secret"],
    ["SELECT", "3"],
  ]);
  await assert.rejects(client.call("NOPE"), (error) => error instanceof RedisError);
  // Still usable after an error reply.
  assert.equal(String(await client.call("ECHO", "d")), "d");
});

test("resp: a dropped connection fails the calls in flight, the next call reconnects", async (t) => {
  let hang = true;
  const redis = await fakeRedis(t, ([name, ...args]) => {
    if (name === "AUTH") return "+OK\r\n";
    if (name === "ECHO" && hang) return undefined; // never answered
    return `$${args[0]?.length ?? 2}\r\n${args[0] ?? "OK"}\r\n`;
  });
  const client = redisClient(redis.url, { password: "secret" });
  t.after(() => client.close());
  const lost = client.call("ECHO", "x");
  // Once the server has read it, after the AUTH: the connection dropped is the one it was on.
  await until(() => redis.got.some(([name]) => name === "ECHO"), { what: "the ECHO" });
  redis.drop();
  await assert.rejects(lost, /closed|ECONNRESET/);
  hang = false;
  assert.equal(String(await client.call("ECHO", "y")), "y");
  // Authenticated again on the new connection.
  assert.equal(redis.got.filter(([name]) => name === "AUTH").length, 2);
});

test("resp: a call nothing answers fails in time, and the next one connects again", async (t) => {
  let answer = false;
  const redis = await fakeRedis(t, () => (answer ? "+PONG\r\n" : undefined));
  // Long enough for the second call to connect again and be answered on a paused runner.
  const client = redisClient(redis.url, { timeoutMs: 500 });
  t.after(() => client.close());
  const started = Date.now();
  await assert.rejects(client.call("PING"), /didn't answer within 500 ms/);
  assert.ok(Date.now() - started < 5000);
  answer = true;
  assert.equal(await client.call("PING"), "PONG");
});

test("resp: a server that isn't Redis fails the calls, the client doesn't crash", async (t) => {
  const redis = await fakeRedis(t, () => "HTTP/1.1 400 Bad Request\r\n\r\n");
  const client = redisClient(redis.url);
  t.after(() => client.close());
  await assert.rejects(client.call("PING"), /not a Redis reply/);
  await assert.rejects(client.call("PING"), /not a Redis reply/);
});

test("resp: a refused password fails the call, and the next tries again", async (t) => {
  let password = "wrong";
  const redis = await fakeRedis(t, ([name, ...args]) => {
    if (name === "AUTH") return args[0] === password ? "+OK\r\n" : "-WRONGPASS invalid\r\n";
    return "+PONG\r\n";
  });
  const client = redisClient(redis.url, { password: "right" });
  t.after(() => client.close());
  await assert.rejects(client.call("PING"), /WRONGPASS/);
  password = "right";
  assert.equal(await client.call("PING"), "PONG");
});

test("redis store: a script Redis doesn't know is sent whole, once", async (t) => {
  const known = new Set();
  const redis = await fakeRedis(t, ([name, script]) => {
    if (name === "EVALSHA") return known.has(script) ? "$-1\r\n" : "-NOSCRIPT No matching\r\n";
    if (name === "EVAL") {
      known.add(createHashOf(script));
      return "$-1\r\n";
    }
    return "+OK\r\n";
  });
  const store = redisStore({ url: redis.url, prefix: "p:", now: () => 5 });
  t.after(() => store.close());
  assert.equal(await store.get("a"), null);
  assert.equal(await store.get("b"), null);
  const names = redis.got.map(([name]) => name);
  assert.deepEqual(names, ["EVALSHA", "EVAL", "EVALSHA"]);
  // Keys under the prefix, the clock passed along.
  assert.deepEqual(redis.got[2].slice(2), ["1", "p:k:b", "5"]);
});

const createHashOf = (source) => createHash("sha1").update(source).digest("hex");

test("openStore: redis: and rediss: connect only when first used", async () => {
  const store = openStore("redis://nowhere.invalid:6379?prefix=x:");
  await store.close();
  await openStore("rediss://nowhere.invalid").close();
});

// A real Redis: TEST_REDIS_URL, else one started from redis-server on the PATH. Null: none.
async function realRedis() {
  if (process.env.TEST_REDIS_URL) return process.env.TEST_REDIS_URL;
  try {
    execFileSync("redis-server", ["--version"], { stdio: "ignore" });
  } catch {
    return null;
  }
  // On a port the OS never hands out by itself, not one probed free first (#563): another one
  // when something else has it already, which this redis-server's process id tells apart.
  for (let tries = 0; tries < 20; tries++) {
    const port = asidePort();
    const server = spawn(
      "redis-server",
      ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"],
      { stdio: "ignore" },
    );
    server.unref();
    process.once("exit", () => server.kill());
    const url = `redis://127.0.0.1:${port}`;
    for (let i = 0; i < 50 && server.exitCode === null; i++) {
      const client = redisClient(url);
      try {
        const info = String(await client.call("INFO", "server"));
        if (info.includes(`process_id:${server.pid}\r\n`)) return url;
        break;
      } catch {
        await sleep(100);
      } finally {
        await client.close();
      }
    }
    server.kill();
  }
  throw new Error("redis-server didn't start");
}

// docs/setup.md's user, its keys under `deckhand-test:` rather than `deckhand:`: the stores the
// tests open call Redis as it, so a command the store sends that its ACL lacks fails them
// (NOPERM). Removed once the file's tests are done. → a URL signing in as it.
async function setupUser(url) {
  const line = /^user deckhand on (.*)$/m.exec(
    readFileSync(join(import.meta.dirname, "..", "docs", "setup.md"), "utf8"),
  )[1];
  const name = `deckhand-test-${randomUUID()}`;
  const password = randomUUID();
  // Its password, `<a long random password>`, one of the tests'.
  const rules = line
    .replace(/>(<[^>]*>|\S+)/, `>${password}`)
    .split(" ")
    .map((rule) => (rule === "~deckhand:*" ? "~deckhand-test:*" : rule));
  assert.ok(rules.includes("~deckhand-test:*"), line);
  const admin = redisClient(url);
  try {
    await admin.call("ACL", "SETUSER", name, "reset", "on", ...rules);
  } finally {
    await admin.close();
  }
  after(async () => {
    const client = redisClient(url);
    await client.call("ACL", "DELUSER", name);
    await client.close();
  });
  const signed = new URL(url);
  signed.username = name;
  signed.password = password;
  return signed.href;
}

const redisUrl = await realRedis();
const skip = redisUrl ? false : "no Redis: set TEST_REDIS_URL, or put redis-server on the PATH";
// The stores' (docs/setup.md's ACL); redisUrl's is the tests' own, to look at what they wrote.
const storeUrl = redisUrl && (await setupUser(redisUrl));

// Each test its own prefix, its keys deleted after it: a Redis shared with others keeps theirs.
function freshPrefix(t) {
  const prefix = `deckhand-test:${randomUUID()}:`;
  t.after(async () => {
    const client = redisClient(redisUrl);
    let cursor = "0";
    do {
      const [next, keys] = await client.call("SCAN", cursor, "MATCH", `${prefix}*`, "COUNT", 1000);
      cursor = String(next);
      if (keys.length) await client.call("DEL", ...keys);
    } while (cursor !== "0");
    await client.close();
  });
  return prefix;
}

if (redisUrl) {
  storeContract("redis", (t, clock) =>
    redisStore({ url: storeUrl, prefix: freshPrefix(t), now: clock.now }),
  );
} else {
  test("redis: the shared suite", { skip }, () => {});
}

test(
  "redis: two copies on Redis's clock, a lease taken over on release and on expiry",
  { skip },
  async (t) => {
    const prefix = freshPrefix(t);
    const a = redisStore({ url: storeUrl, prefix });
    const b = redisStore({ url: storeUrl, prefix });
    t.after(() => Promise.all([a.close(), b.close()]));

    const first = await a.acquire("orchestrator", "copy-a", { ttlMs: 10_000 });
    assert.equal(await b.acquire("orchestrator", "copy-b", { ttlMs: 10_000 }), null);
    assert.equal((await b.lease("orchestrator")).holder, "copy-a");
    // Released on SIGTERM: the other copy takes it at once, with a higher epoch.
    assert.equal(await a.release("orchestrator", "copy-a", first.epoch), true);
    // A second: long enough to outlive the next call on a paused runner.
    const second = await b.acquire("orchestrator", "copy-b", { ttlMs: 1000 });
    assert.ok(second.epoch > first.epoch);
    // Copy b stops renewing (killed, its node gone): once it expires, a takes it back.
    assert.equal(await a.acquire("orchestrator", "copy-a", { ttlMs: 1000 }), null);
    await sleep(1100);
    const third = await a.acquire("orchestrator", "copy-a", { ttlMs: 10_000 });
    assert.ok(third.epoch > second.epoch);
    assert.equal(await b.renew("orchestrator", "copy-b", second.epoch, { ttlMs: 1000 }), null);

    // What one copy writes, the other reads; a key's TTL is Redis's own.
    await a.set("session", { user: "alice" }, { ttlMs: 1000 });
    assert.deepEqual(await b.get("session"), { user: "alice" });
    const client = redisClient(redisUrl);
    t.after(() => client.close());
    const pttl = await client.call("PTTL", `${prefix}k:session`);
    assert.ok(pttl > 0 && pttl <= 1000, `PTTL ${pttl}`);
    await sleep(1100);
    assert.equal(await b.get("session"), null);

    // An event one copy appended, the next one reads until acknowledged.
    const id = await a.append("runs", { n: 1 });
    assert.deepEqual(await a.read("runs", "orchestrator"), [{ id, event: { n: 1 } }]);
    assert.deepEqual(await b.read("runs", "orchestrator"), [{ id, event: { n: 1 } }]);
    assert.equal(await b.ack("runs", "orchestrator", [id]), 1);
    assert.deepEqual(await a.read("runs", "orchestrator"), []);
  },
);

test(
  "redis: events trimmed away while pending are skipped, the rest still read",
  { skip },
  async (t) => {
    const store = redisStore({ url: storeUrl, prefix: freshPrefix(t) });
    t.after(() => store.close());
    for (let n = 1; n <= 3; n++) await store.append("progress", { n });
    assert.equal((await store.read("progress", "edge")).length, 3);
    for (let n = 4; n <= 6; n++) await store.append("progress", { n }, { maxLength: 2 });
    const events = (list) => list.map((e) => e.event.n);
    // 1-3 were pending and trimmed: gone, as is 4.
    assert.deepEqual(events(await store.read("progress", "edge", { count: 1 })), [5]);
    assert.deepEqual(events(await store.read("progress", "edge")), [5, 6]);
  },
);

test(
  "redis: a lease Redis lost the last writes of still gets a new, higher epoch",
  { skip },
  async (t) => {
    const prefix = freshPrefix(t);
    const store = redisStore({ url: storeUrl, prefix });
    const client = redisClient(redisUrl);
    t.after(() => Promise.all([store.close(), client.close()]));
    const key = `${prefix}l:orchestrator`;
    const first = await store.acquire("orchestrator", "copy-a", { ttlMs: 10_000 });
    await store.release("orchestrator", "copy-a", first.epoch);
    const saved = (await client.call("HGETALL", key)).map(String);
    await sleep(5);
    const second = await store.acquire("orchestrator", "copy-b", { ttlMs: 10_000 });
    assert.ok(second.epoch > first.epoch);
    // Redis crashed before copy b's lease was on disk: it is back to the released one.
    await client.call("HSET", key, ...saved);
    await sleep(5);
    const third = await store.acquire("orchestrator", "copy-a", { ttlMs: 10_000 });
    assert.ok(third.epoch > second.epoch, `${third.epoch} after ${second.epoch}`);
  },
);

test("redis: blobs are bytes", { skip }, async (t) => {
  const store = redisStore({ url: storeUrl, prefix: freshPrefix(t) });
  t.after(() => store.close());
  const bytes = Buffer.from([0, 1, 0xff, 0x0d, 0x0a, 0x80]);
  await store.putBlob("shot.png", bytes);
  await store.appendBlob("shot.png", Buffer.from([7]));
  assert.deepEqual(await store.readBlob("shot.png"), Buffer.concat([bytes, Buffer.from([7])]));
  assert.deepEqual(await store.readBlob("shot.png", { offset: 5 }), Buffer.from([0x80, 7]));
});

test("redis: a known secret is never written to it", { skip }, async (t) => {
  const prefix = freshPrefix(t);
  const appKey = `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${"A".repeat(64)}\n-----END RSA PRIVATE KEY-----`;
  const signingKey = "sk-signing-0123456789abcdef0123456789";
  const store = openStore(`${storeUrl}?prefix=${prefix}`, { secrets: () => [signingKey] });
  t.after(() => store.close());
  await assert.rejects(store.set("app", { key: appKey }), /a secret can't go in the store/);
  await assert.rejects(store.append("runs", { token: signingKey }), /a secret/);
  await store.putBlob("log", `signed with ${signingKey}\n`);
  const client = redisClient(redisUrl);
  t.after(() => client.close());
  const [, keys] = await client.call("SCAN", "0", "MATCH", `${prefix}*`, "COUNT", 1000);
  assert.deepEqual(keys.map(String), [`${prefix}b:log`]);
  assert.equal(String(await client.call("GET", `${prefix}b:log`)), "signed with [redacted]\n");
});

test(
  "redis: two stores with different prefixes don't list each other's keys",
  { skip },
  async (t) => {
    const a = redisStore({ url: storeUrl, prefix: freshPrefix(t) });
    const b = redisStore({ url: storeUrl, prefix: freshPrefix(t) });
    t.after(() => Promise.all([a.close(), b.close()]));
    await a.set("waits/1", "a");
    await a.set("waits/2", "a");
    await b.set("waits/1", "b");
    const all = async (store) => new Map(await Array.fromAsync(values(store, "")));
    assert.deepEqual(
      await all(a),
      new Map([
        ["waits/1", "a"],
        ["waits/2", "a"],
      ]),
    );
    assert.deepEqual(await all(b), new Map([["waits/1", "b"]]));
  },
);
