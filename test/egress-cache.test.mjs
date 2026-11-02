// The egress proxy's cache (proxy/cache.mjs) through the proxy, against a local upstream that
// counts what reaches it, with a temp dir and a fake clock.
import assert from "node:assert/strict";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { unlink as unlinkFile } from "node:fs/promises";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { createCache, lifetime, parseSize } from "../proxy/cache.mjs";
import { createProxy } from "../proxy/proxy.mjs";
import { listening, serve, tempDir, until } from "./helpers.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An upstream answering each path with `routes[path](req, res)` (default: a 200 body), a
// proxy caching `cached.test` only, and a clock tests move.
async function setup(t, routes = {}, { max = 1024 * 1024, entryMax = 1024 * 1024 } = {}) {
  const seen = [];
  const { port: upstreamPort } = await serve(t, (req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const route = routes[req.url];
    if (route) return route(req, res);
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "max-age=60" });
    res.end(`body of ${req.url}`);
  });
  const clock = { now: 1_000_000 };
  const dir = tempDir(t, "deckhand-egress-cache-");
  const cache = createCache({ dir, max, entryMax, now: () => clock.now });
  // The downloads the proxy asked it to keep (their URL's path): "never stored" is none asked,
  // not no file seen a while later.
  const written = [];
  const writer = cache.writer;
  cache.writer = (key, meta) => (written.push(new URL(meta.url).pathname), writer(key, meta));
  const proxy = createProxy({
    policy: async (ip, host) => ({ allowed: true, private: true, cache: host === "cached.test" }),
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    blocked: () => false,
    cache,
    now: () => clock.now,
  });
  const proxyPort = await listening(proxy);
  t.after(() => proxy.close());
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
    await until(() => cache.has(key), { what: `${path} in the cache` });
    return true;
  };
  const files = () => readdirSync(dir).sort();
  return { get, seen, clock, cache, dir, stored, files, written, url, upstreamPort, proxyPort };
}

test("a second GET on a cached host is answered from disk", async (t) => {
  const { get, seen, stored, files, cache } = await setup(t);
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
  await cache.settled();
  assert.equal(files().length, 2);
  assert.match(files()[0], /^[0-9a-f]{64}\.body$/);
});

test("other hosts, and requests that aren't a plain GET, are forwarded as before", async (t) => {
  const { get, seen, files, cache, written } = await setup(t);
  for (let i = 0; i < 2; i++) {
    const answer = await get("/x", {}, "other.test");
    assert.equal(answer.body, "body of /x");
    assert.equal(answer.headers["x-deckhand-cache"], undefined);
  }
  await get("/x", { authorization: "Bearer t" });
  await get("/x", { cookie: "a=b" });
  await get("/x", { range: "bytes=0-3" });
  await get("/x", { "cache-control": "no-store" });
  assert.equal(seen.length, 6);
  assert.deepEqual(written, []);
  await cache.settled();
  assert.deepEqual(files(), []);
  // Credentials reach the host.
  assert.equal(seen[2].headers.authorization, "Bearer t");
});

// Sends `head` (and a body, when it has one) to the proxy as is: what Node's client wouldn't.
function raw(port, head) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (d) => (data += d));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.write(head);
  });
}

test("a GET with a body or credential-like headers is forwarded, never stored", async (t) => {
  const { get, seen, files, cache, written, proxyPort, url } = await setup(t);
  const sent = [
    `content-length: 4\r\n\r\nbody`,
    `transfer-encoding: chunked\r\n\r\n4\r\nbody\r\n0\r\n\r\n`,
    `expect: 100-continue\r\ncontent-length: 0\r\n\r\n`,
  ];
  for (const rest of sent) {
    const answer = await raw(
      proxyPort,
      `GET ${url("/x")} HTTP/1.1\r\nhost: cached.test\r\nconnection: close\r\n${rest}`,
    );
    assert.match(answer, /HTTP\/1\.1 200[^]*body of \/x/);
    assert.doesNotMatch(answer, /x-deckhand-cache/);
  }
  const credentials = [
    { "private-token": "glpat" },
    { "job-token": "j" },
    { "x-jfrog-art-api": "k" },
    { "x-api-key": "k" },
    { "x-goog-api-key": "k" },
  ];
  for (const headers of credentials) {
    const answer = await get("/x", headers);
    assert.equal(answer.headers["x-deckhand-cache"], undefined, Object.keys(headers)[0]);
  }
  assert.equal(seen.length, sent.length + credentials.length);
  assert.deepEqual(written, []);
  await cache.settled();
  assert.deepEqual(files(), []);
  // They reach the host, as before.
  assert.equal(seen.at(-1).headers["x-goog-api-key"], "k");
  // npm's, on every request, and the proxy's own aren't credentials.
  const npm = await get("/y", { "npm-auth-type": "web", "proxy-authorization": "Basic eA==" });
  assert.equal(npm.headers["x-deckhand-cache"], "miss");
});

test("only a short list of request headers reaches the host on the cache path", async (t) => {
  const { get, seen, upstreamPort } = await setup(t);
  await get("/pkg", {
    accept: "*/*",
    "accept-encoding": "gzip",
    "accept-language": "en",
    "user-agent": "apt",
    "x-http-method-override": "DELETE",
    "x-forwarded-host": "evil.test",
    te: "trailers",
    "keep-alive": "timeout=5",
  });
  const headers = { ...seen[0].headers };
  // Node's own, for a connection that isn't pooled.
  assert.equal(headers.connection, "close");
  delete headers.connection;
  assert.deepEqual(headers, {
    host: `cached.test:${upstreamPort}`,
    accept: "*/*",
    "accept-encoding": "gzip",
    "accept-language": "en",
    "user-agent": "apt",
  });
});

// The review's scenario, against a host that answers a GET before reading its body, then
// takes the next Content-Length bytes on that connection as the body: a later request's
// header then reads as a request of its own, whose answer the cache would keep under the
// later one's URL.
test("a host that answers before reading the body can't be made to poison an entry", async (t) => {
  const host = createServer((socket) => {
    let buffer = "";
    let skip = 0;
    socket.on("error", () => {});
    socket.on("data", (data) => {
      buffer += data;
      for (;;) {
        const dropped = Math.min(skip, buffer.length);
        buffer = buffer.slice(dropped);
        skip -= dropped;
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.slice(0, end);
        buffer = buffer.slice(end + 4);
        const path = head.split(" ")[1];
        skip = Number(/\r\ncontent-length: *(\d+)/i.exec(head)?.[1] ?? 0);
        const body = `body of ${path}`;
        socket.write(
          `HTTP/1.1 200 OK\r\ncache-control: max-age=60\r\ncontent-length: ${body.length}\r\n\r\n${body}`,
        );
      }
    });
  });
  const port = await listening(host);
  t.after(() => host.close());
  const cache = createCache({ dir: tempDir(t, "deckhand-egress-cache-") });
  const proxy = createProxy({
    policy: async () => ({ allowed: true, private: true, cache: true }),
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    blocked: () => false,
    cache,
  });
  const proxyPort = await listening(proxy);
  t.after(() => proxy.close());
  const url = (path) => `http://cached.test:${port}${path}`;
  // What the host reads up to the header's value: the bytes it skips.
  const skipped = `GET /victim HTTP/1.1\r\nhost: cached.test:${port}\r\nx-a: `.length;
  const body = "b".repeat(skipped);
  await raw(
    proxyPort,
    `GET ${url("/b")} HTTP/1.1\r\nhost: x\r\ncontent-length: ${skipped}\r\n` +
      `connection: close\r\n\r\n${body}`,
  );
  await raw(
    proxyPort,
    `GET ${url("/victim")} HTTP/1.1\r\nhost: x\r\nx-a: GET /evil HTTP/1.1\r\n` +
      `connection: close\r\n\r\n`,
  );
  await until(() => cache.has(cache.key(url("/victim"))), { what: "/victim in the cache" });
  // Another repository's sandbox.
  const answer = await raw(
    proxyPort,
    `GET ${url("/victim")} HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n`,
  );
  assert.match(answer, /body of \/victim$/);
  assert.doesNotMatch(answer, /evil/);
});

// A cache of 400 bytes (200 at most per entry, and being written) holding three entries of
// 100, each used after the one before; `onDisk()`: the bodies' bytes, temporary files too.
// `unlinkDelay`: each file removed that many ms late, as on a slow disk.
async function smallCache(t, { unlinkDelay = 0 } = {}) {
  const dir = tempDir(t, "deckhand-egress-cache-");
  const clock = { now: 1000 };
  const unlink = async (path) => {
    await wait(unlinkDelay);
    return unlinkFile(path);
  };
  const cache = createCache({ dir, max: 400, entryMax: 200, now: () => clock.now++, unlink });
  const onDisk = () =>
    readdirSync(dir)
      .filter((name) => !name.endsWith(".json"))
      .reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
  const write = (path, headers = {}) =>
    cache.writer(cache.key(path), { url: path, status: 200, headers });
  for (const path of ["/old1", "/old2", "/old3"]) {
    const writer = write(path);
    writer.write(Buffer.alloc(100));
    assert.equal(await writer.commit(), true);
  }
  const kept = (path) => cache.has(cache.key(path));
  return { cache, onDisk, write, kept };
}

for (const unlinkDelay of [0, 50]) {
  test(`parallel downloads stay under the cache's size, and evict half of it at most (files removed ${unlinkDelay} ms late)`, async (t) => {
    const { cache, onDisk, write, kept } = await smallCache(t, { unlinkDelay });
    // Three downloads of 100 bytes without a Content-Length at once, chunk by chunk.
    const writers = ["/a", "/b", "/c"].map((path) => write(path));
    const taken = [];
    for (let i = 0; i < 10; i++) {
      for (const writer of writers) {
        taken.push(writer.write(Buffer.alloc(10)));
        assert.ok(cache.size <= 400, `${cache.size} bytes`);
      }
      // An aborted download's file, and the entries evicted, are removed meanwhile: their bytes
      // no longer counted.
      await cache.settled();
      assert.ok(onDisk() <= 400, `${onDisk()} bytes on disk`);
    }
    // The oldest entry went to make room; the downloads' share full, the last one was dropped.
    assert.equal(kept("/old1"), false);
    assert.ok(taken.includes(false));
    // Half of the cache is never evicted for downloads under way.
    assert.ok(kept("/old2") && kept("/old3"));
    const done = await Promise.all(writers.map((writer) => writer.commit()));
    assert.deepEqual(done, [true, true, false]);
    await cache.settled();
    assert.equal(cache.size, 400);
    assert.ok(onDisk() <= 400, `${onDisk()} bytes on disk`);
  });
}

test("a download's Content-Length is reserved as it starts, and evicts no more", async (t) => {
  const { cache, write, kept } = await smallCache(t);
  const big = write("/big", { "content-length": "150" });
  assert.equal(cache.size, 450 - 100);
  assert.equal(kept("/old1"), false);
  for (let i = 0; i < 15; i++) assert.equal(big.write(Buffer.alloc(10)), true);
  assert.ok(kept("/old2") && kept("/old3"));
  // More than its Content-Length: dropped.
  const liar = write("/liar", { "content-length": "10" });
  assert.equal(liar.write(Buffer.alloc(20)), false);
  // Past the downloads' share: not started, nothing evicted.
  assert.equal(write("/more", { "content-length": "100" }), null);
  assert.ok(kept("/old2") && kept("/old3"));
  // Dropped before its end: its reservation is given back.
  await big.abort();
  await cache.settled();
  assert.equal(cache.size, 200);
});

test("answers that aren't the same for everyone are never stored", async (t) => {
  const answer = (status, headers) => (req, res) => {
    res.writeHead(status, headers);
    res.end("x".repeat(100));
  };
  const routes = {
    "/private": answer(200, { "cache-control": "private, max-age=60" }),
    "/no-store": answer(200, { "cache-control": "no-store" }),
    "/missing": answer(404, { "cache-control": "max-age=60" }),
    // Varies on a header the request sends, or on anything.
    "/vary": answer(200, { vary: "User-Agent", "cache-control": "max-age=60" }),
    "/vary-all": answer(200, { vary: "*", "cache-control": "max-age=60" }),
    "/big": answer(200, { "cache-control": "max-age=60", "content-length": "100" }),
    // No Content-Length: counted as it comes.
    "/big-chunked": (req, res) => {
      res.writeHead(200, { "cache-control": "max-age=60" });
      res.write("x".repeat(60));
      res.end("x".repeat(40));
    },
  };
  const { get, seen, files, cache, written } = await setup(t, routes, { entryMax: 99 });
  for (const path of Object.keys(routes)) {
    for (let i = 0; i < 2; i++) {
      const got = await get(path, { "user-agent": "apt" });
      assert.equal(got.body, "x".repeat(100), path);
      assert.equal(got.headers["x-deckhand-cache"], "miss", path);
    }
  }
  assert.equal(seen.length, Object.keys(routes).length * 2);
  // Only the one without a Content-Length is started, then dropped past its size: its file
  // removed in the background.
  assert.deepEqual(written, ["/big-chunked", "/big-chunked"]);
  await cache.settled();
  assert.deepEqual(files(), []);
});

test("a cookie a CDN sets on everything doesn't keep an answer out, and isn't kept", async (t) => {
  const routes = {
    // Cloudflare's, on every answer of npm's registry.
    "/left-pad.tgz": (req, res) => {
      res.writeHead(200, { "set-cookie": "__cf_bm=1; Path=/", "cache-control": "max-age=60" });
      res.end("tarball");
    },
  };
  const { get, seen, stored } = await setup(t, routes);
  const first = await get("/left-pad.tgz");
  assert.equal(first.headers["x-deckhand-cache"], "miss");
  assert.deepEqual(first.headers["set-cookie"], ["__cf_bm=1; Path=/"]);
  assert.ok(await stored("/left-pad.tgz"));
  const second = await get("/left-pad.tgz");
  assert.equal(second.headers["x-deckhand-cache"], "hit");
  assert.equal(second.body, "tarball");
  assert.equal(second.headers["set-cookie"], undefined);
  assert.equal(seen.length, 1);
});

test("an answer varying on a header is kept for requests without it, Accept in the key", async (t) => {
  const routes = {
    // dl-cdn.alpinelinux.org's.
    "/APKINDEX.tar.gz": (req, res) => {
      res.writeHead(200, { vary: "Origin", "cache-control": "max-age=60" });
      res.end(`index for ${req.headers.origin ?? "anyone"}`);
    },
    // npm's registry: a packument by Accept.
    "/left-pad": (req, res) => {
      res.writeHead(200, { vary: "accept-encoding, accept", "cache-control": "max-age=60" });
      res.end(`packument as ${req.headers.accept}`);
    },
  };
  const { get, seen, cache, url, stored } = await setup(t, routes);
  await get("/APKINDEX.tar.gz");
  assert.ok(await stored("/APKINDEX.tar.gz"));
  const hit = await get("/APKINDEX.tar.gz");
  assert.equal(hit.headers["x-deckhand-cache"], "hit");
  // One with Origin goes on to the host, and leaves the entry alone.
  const cors = await get("/APKINDEX.tar.gz", { origin: "https://a.test" });
  assert.equal(cors.body, "index for https://a.test");
  assert.equal(cors.headers["x-deckhand-cache"], undefined);
  assert.equal((await get("/APKINDEX.tar.gz")).headers["x-deckhand-cache"], "hit");
  assert.equal(seen.length, 2);

  const corgi = "application/vnd.npm.install-v1+json";
  await get("/left-pad", { accept: corgi });
  const json = await get("/left-pad", { accept: "application/json" });
  assert.equal(json.headers["x-deckhand-cache"], "miss");
  assert.equal(json.body, "packument as application/json");
  for (let i = 0; i < 50 && !cache.has(cache.key(url("/left-pad"), undefined, corgi)); i++) {
    await wait(5);
  }
  const again = await get("/left-pad", { accept: corgi });
  assert.equal(again.headers["x-deckhand-cache"], "hit");
  assert.equal(again.body, `packument as ${corgi}`);
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
  const { files, cache, upstreamPort, proxyPort } = await setup(t, routes);
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
  // Its download dropped before the upstream's, so its file's removal is under way by now.
  await cache.settled();
  assert.deepEqual(files(), []);
});

test("a client that disconnects while a cached body is served: its file is closed (#523)", async (t) => {
  // Large enough for backpressure to hold the body's stream when the client stops reading.
  const big = "y".repeat(8 * 1024 * 1024);
  const routes = {
    "/big": (req, res) => {
      res.writeHead(200, { "cache-control": "max-age=60", "content-length": big.length });
      res.end(big);
    },
  };
  const max = 32 * 1024 * 1024;
  const { get, stored, cache, upstreamPort, proxyPort } = await setup(t, routes, {
    max,
    entryMax: max,
  });
  assert.equal((await get("/big")).body.length, big.length);
  assert.ok(await stored("/big"));
  // Each file the cache hands out, and whether it was closed. Left open, the garbage collector
  // closes it, which ends the process on Node 26.
  const files = [];
  const get0 = cache.get.bind(cache);
  cache.get = async (key) => {
    const entry = await get0(key);
    if (entry) {
      const close = entry.file.close.bind(entry.file);
      const seen = { closed: false };
      files.push(seen);
      entry.file.close = () => ((seen.closed = true), close());
    }
    return entry;
  };
  await new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port: proxyPort, path: `http://cached.test:${upstreamPort}/big` },
      () => {},
    );
    req.on("error", () => {});
    req.on("response", (res) => {
      assert.equal(res.headers["x-deckhand-cache"], "hit");
      res.once("data", () => {
        req.destroy();
        resolve();
      });
    });
    req.end();
  });
  for (let i = 0; i < 100 && !files[0]?.closed; i++) await wait(10);
  assert.deepEqual(files, [{ closed: true }]);
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
