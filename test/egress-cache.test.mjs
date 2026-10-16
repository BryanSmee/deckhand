// The egress proxy's cache (proxy/cache.mjs) through the proxy, against a local upstream that
// counts what reaches it, with a temp dir and a fake clock.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCache, lifetime, parseSize } from "../proxy/cache.mjs";
import { createProxy } from "../proxy/proxy.mjs";

async function listening(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An upstream answering each path with `routes[path](req, res)` (default: a 200 body), a
// proxy caching `cached.test` only, and a clock tests move.
async function setup(t, routes = {}, { max = 1024 * 1024, entryMax = 1024 * 1024 } = {}) {
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const route = routes[req.url];
    if (route) return route(req, res);
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "max-age=60" });
    res.end(`body of ${req.url}`);
  });
  const upstreamPort = await listening(upstream);
  const clock = { now: 1_000_000 };
  const dir = mkdtempSync(join(tmpdir(), "deckhand-egress-cache-"));
  const cache = createCache({ dir, max, entryMax, now: () => clock.now });
  const proxy = createProxy({
    policy: async (ip, host) => ({ allowed: true, private: true, cache: host === "cached.test" }),
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    blocked: () => false,
    cache,
    now: () => clock.now,
  });
  const proxyPort = await listening(proxy);
  t.after(() => {
    proxy.close();
    upstream.close();
  });
  // GET through the proxy: { status, headers, body }.
  const get = (path, headers = {}, host = "cached.test") =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          path: `http://${host}:${upstreamPort}${path}`,
          headers: { connection: "close", ...headers },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  const url = (path, host = "cached.test") => `http://${host}:${upstreamPort}${path}`;
  // Once the download it just served is written (or not) to disk.
  const stored = async (path, encoding) => {
    const key = cache.key(url(path), encoding);
    for (let i = 0; i < 50 && !cache.has(key); i++) await wait(5);
    return cache.has(key);
  };
  const files = () => readdirSync(dir).sort();
  return { get, seen, clock, cache, dir, stored, files, url, upstreamPort, proxyPort };
}

test("a second GET on a cached host is answered from disk", async (t) => {
  const { get, seen, stored, files } = await setup(t);
  const first = await get("/pkg.deb");
  assert.equal(first.status, 200);
  assert.equal(first.body, "body of /pkg.deb");
  assert.equal(first.headers["x-deckhand-cache"], "miss");
  assert.ok(await stored("/pkg.deb"));
  const second = await get("/pkg.deb");
  assert.equal(second.body, "body of /pkg.deb");
  assert.equal(second.headers["x-deckhand-cache"], "hit");
  assert.equal(second.headers["content-type"], "text/plain");
  assert.equal(second.headers["content-length"], String("body of /pkg.deb".length));
  assert.equal(seen.length, 1);
  // One body and its metadata, no temporary file (once its last use is written).
  await wait(20);
  assert.equal(files().length, 2);
  assert.match(files()[0], /^[0-9a-f]{64}\.body$/);
});

test("other hosts, and requests that aren't a plain GET, are forwarded as before", async (t) => {
  const { get, seen, files } = await setup(t);
  for (let i = 0; i < 2; i++) {
    const answer = await get("/x", {}, "other.test");
    assert.equal(answer.body, "body of /x");
    assert.equal(answer.headers["x-deckhand-cache"], undefined);
  }
  await get("/x", { authorization: "Bearer t" });
  await get("/x", { cookie: "a=b" });
  await get("/x", { range: "bytes=0-3" });
  await get("/x", { "cache-control": "no-store" });
  await wait(30);
  assert.equal(seen.length, 6);
  assert.deepEqual(files(), []);
  // Credentials reach the host.
  assert.equal(seen[2].headers.authorization, "Bearer t");
});

test("answers that aren't the same for everyone are never stored", async (t) => {
  const answer = (status, headers) => (req, res) => {
    res.writeHead(status, headers);
    res.end("x".repeat(100));
  };
  const routes = {
    "/private": answer(200, { "cache-control": "private, max-age=60" }),
    "/no-store": answer(200, { "cache-control": "no-store" }),
    "/cookie": answer(200, { "set-cookie": "id=1", "cache-control": "max-age=60" }),
    "/missing": answer(404, { "cache-control": "max-age=60" }),
    "/vary": answer(200, { vary: "User-Agent", "cache-control": "max-age=60" }),
    "/big": answer(200, { "cache-control": "max-age=60", "content-length": "100" }),
    // No Content-Length: counted as it comes.
    "/big-chunked": (req, res) => {
      res.writeHead(200, { "cache-control": "max-age=60" });
      res.write("x".repeat(60));
      res.end("x".repeat(40));
    },
  };
  const { get, seen, files } = await setup(t, routes, { entryMax: 99 });
  for (const path of Object.keys(routes)) {
    for (let i = 0; i < 2; i++) {
      const got = await get(path);
      assert.equal(got.body, "x".repeat(100), path);
      assert.equal(got.headers["x-deckhand-cache"], "miss", path);
    }
  }
  await wait(30);
  assert.equal(seen.length, Object.keys(routes).length * 2);
  assert.deepEqual(files(), []);
});

test("a stale entry is revalidated, and a 304 serves it", async (t) => {
  const routes = {
    "/Release": (req, res) => {
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304, { etag: '"v1"', "cache-control": "max-age=60" });
        return res.end();
      }
      res.writeHead(200, { etag: '"v1"', "cache-control": "max-age=60" });
      res.end("release v1");
    },
  };
  const { get, seen, clock, stored } = await setup(t, routes);
  await get("/Release");
  assert.ok(await stored("/Release"));
  clock.now += 30_000;
  assert.equal((await get("/Release")).headers["x-deckhand-cache"], "hit");
  clock.now += 31_000;
  const again = await get("/Release");
  assert.equal(again.status, 200);
  assert.equal(again.body, "release v1");
  assert.equal(again.headers["x-deckhand-cache"], "revalidated");
  assert.equal(seen.length, 2);
  assert.equal(seen[1].headers["if-none-match"], '"v1"');
  // Fresh again from the 304.
  clock.now += 30_000;
  assert.equal((await get("/Release")).headers["x-deckhand-cache"], "hit");
  // A client asking for no-cache gets it revalidated.
  assert.equal(
    (await get("/Release", { "cache-control": "no-cache" })).headers["x-deckhand-cache"],
    "revalidated",
  );
  // A client's own validator that matches: a 304 from the cache.
  const mine = await get("/Release", { "if-none-match": '"v1"' });
  assert.equal(mine.status, 304);
  assert.equal(mine.headers["x-deckhand-cache"], "hit");
  assert.equal(seen.length, 3);
});

test("a stale entry the host changed is replaced", async (t) => {
  let version = 1;
  const routes = {
    "/index": (req, res) => {
      res.writeHead(200, {
        "last-modified": new Date(version * 1e9).toUTCString(),
        "cache-control": "max-age=0",
      });
      res.end(`index v${version}`);
    },
  };
  const { get, stored, seen } = await setup(t, routes);
  await get("/index");
  assert.ok(await stored("/index"));
  version = 2;
  // Stale at once: checked with its Last-Modified, and the host answers anew.
  const second = await get("/index");
  assert.equal(second.body, "index v2");
  assert.equal(second.headers["x-deckhand-cache"], "miss");
  assert.ok(seen[1].headers["if-modified-since"]);
  await wait(30);
  version = 3;
  assert.equal((await get("/index")).body, "index v3");
});

test("the cache stays under its size, removing the least recently used", async (t) => {
  const body = (req, res) => {
    res.writeHead(200, { "cache-control": "max-age=600" });
    res.end("y".repeat(100));
  };
  const routes = { "/a": body, "/b": body, "/c": body };
  const { get, clock, stored, cache, url, seen } = await setup(t, routes, { max: 250 });
  await get("/a");
  assert.ok(await stored("/a"));
  clock.now += 1000;
  await get("/b");
  assert.ok(await stored("/b"));
  clock.now += 1000;
  // /a used last: /b goes.
  assert.equal((await get("/a")).headers["x-deckhand-cache"], "hit");
  clock.now += 1000;
  await get("/c");
  assert.ok(await stored("/c"));
  assert.equal(cache.has(cache.key(url("/b"))), false);
  assert.equal(cache.has(cache.key(url("/a"))), true);
  assert.equal(cache.size, 200);
  assert.equal(seen.length, 3);
});

test("EGRESS_CACHE_MAX 0: no cache", async (t) => {
  const { get, seen, files, cache } = await setup(t, {}, { max: 0 });
  assert.equal(cache.enabled, false);
  for (let i = 0; i < 2; i++) {
    assert.equal((await get("/pkg")).headers["x-deckhand-cache"], undefined);
  }
  assert.equal(seen.length, 2);
  assert.deepEqual(files(), []);
});

test("a client that disconnects mid-download leaves no entry behind", async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => (upstreamClosed = resolve));
  const routes = {
    "/slow": (req, res) => {
      res.writeHead(200, { "cache-control": "max-age=60", "content-length": "2000" });
      res.write("z".repeat(1000));
      res.on("close", upstreamClosed);
    },
  };
  const { files, upstreamPort, proxyPort } = await setup(t, routes);
  await new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port: proxyPort, path: `http://cached.test:${upstreamPort}/slow` },
      () => {},
    );
    req.on("error", () => {});
    req.on("response", (res) => {
      res.once("data", () => {
        req.destroy();
        resolve();
      });
    });
    req.end();
  }).catch(() => {});
  await closed;
  await wait(30);
  assert.deepEqual(files(), []);
});

test("an entry left by a previous proxy is found; temporary files are removed", async (t) => {
  const { get, stored, dir, url } = await setup(t);
  await get("/kept");
  assert.ok(await stored("/kept"));
  writeFileSync(join(dir, "tmp-0123"), "half");
  writeFileSync(join(dir, `${"a".repeat(64)}.body`), "orphan");
  const next = createCache({ dir });
  assert.equal(next.has(next.key(url("/kept"))), true);
  assert.equal(readdirSync(dir).length, 2);
});

test("sizes and lifetimes", () => {
  assert.equal(parseSize(undefined, 7), 7);
  assert.equal(parseSize("0", 7), 0);
  assert.equal(parseSize("10g"), 10 * 1024 ** 3);
  assert.equal(parseSize("512M"), 512 * 1024 ** 2);
  assert.equal(parseSize("1048576"), 1048576);
  assert.throws(() => parseSize("lots"));
  assert.equal(lifetime({ "cache-control": "public, max-age=30" }), 30_000);
  assert.equal(lifetime({ "cache-control": "s-maxage=10, max-age=30" }), 10_000);
  assert.equal(lifetime({ "cache-control": "no-cache, max-age=30" }), 0);
  const date = "Thu, 01 Jan 2026 00:00:00 GMT";
  assert.equal(lifetime({ date, expires: "Thu, 01 Jan 2026 00:01:00 GMT" }), 60_000);
  assert.equal(lifetime({ date, expires: "0" }), 0);
  // A tenth of its age, a day at most.
  assert.equal(lifetime({ date, "last-modified": "Wed, 31 Dec 2025 23:00:00 GMT" }), 360_000);
  assert.equal(lifetime({ date, "last-modified": "Thu, 01 Jan 2025 00:00:00 GMT" }), 86_400_000);
  assert.equal(lifetime({}), 0);
});
