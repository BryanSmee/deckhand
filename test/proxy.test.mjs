// The egress proxy against local servers: a fake policy decides, a fake DNS points names at
// 127.0.0.1 (which the real address check refuses, so tests decide that too).
import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";
import { blockedAddress, createProxy, listenerPolicy, target, v6Bytes } from "../proxy/proxy.mjs";
import { listening, serve } from "./helpers.mjs";

// An upstream web server, and a proxy allowing `allowed` hosts (all resolving to it).
async function setup(t, allowed, { blocked = () => false } = {}) {
  const { port: upstreamPort } = await serve(t, (req, res) =>
    res.end(`upstream ${req.method} ${req.url} host=${req.headers.host}`),
  );
  const asked = [];
  const proxy = createProxy({
    policy: async (ip, host) => {
      asked.push([ip, host]);
      return { allowed: allowed.includes(host), private: true };
    },
    lookup: async (host) => {
      if (host === "nowhere.test") throw new Error("ENOTFOUND");
      return [{ address: "127.0.0.1", family: 4 }];
    },
    blocked,
  });
  const proxyPort = await listening(proxy);
  t.after(() => proxy.close());
  return { upstreamPort, proxyPort, asked };
}

// Sends `head` to the proxy and resolves with everything it answers, until it closes or
// `until` shows up.
function raw(port, head, until) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (d) => {
      data += d;
      if (until && data.includes(until)) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.write(head);
  });
}

test("CONNECT to an allowed host tunnels through", async (t) => {
  const { upstreamPort, proxyPort, asked } = await setup(t, ["api.example.com"]);
  const answer = await raw(
    proxyPort,
    `CONNECT api.example.com:${upstreamPort} HTTP/1.1\r\nhost: api.example.com\r\n\r\n` +
      `GET /v1 HTTP/1.1\r\nhost: api.example.com\r\nconnection: close\r\n\r\n`,
    "upstream GET",
  );
  assert.match(answer, /^HTTP\/1\.1 200 Connection Established/);
  assert.match(answer, /upstream GET \/v1 host=api\.example\.com/);
  // The policy is asked with the client's address.
  assert.deepEqual(asked, [["127.0.0.1", "api.example.com"]]);
});

test("CONNECT to any other host is refused, and says why", async (t) => {
  const { proxyPort } = await setup(t, ["api.example.com"]);
  const answer = await raw(proxyPort, `CONNECT evil.example:443 HTTP/1.1\r\n\r\n`);
  assert.match(answer, /^HTTP\/1\.1 403 Forbidden/);
  assert.match(answer, /refused evil\.example: it is not among the hosts this sandbox may reach/);
  assert.match(await raw(proxyPort, `CONNECT nonsense HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 403/);
});

test("plain HTTP is forwarded for allowed hosts only", async (t) => {
  const { upstreamPort, proxyPort } = await setup(t, ["plain.example.com"]);
  const via = (url) =>
    raw(
      proxyPort,
      `GET ${url} HTTP/1.1\r\nhost: x\r\nproxy-authorization: Basic eA==\r\nconnection: close\r\n\r\n`,
    );
  const ok = await via(`http://plain.example.com:${upstreamPort}/a?b=1`);
  assert.match(ok, /^HTTP\/1\.1 200/);
  assert.match(ok, new RegExp(`upstream GET /a\\?b=1 host=plain\\.example\\.com:${upstreamPort}`));
  assert.match(await via(`http://other.example.com:${upstreamPort}/`), /^HTTP\/1\.1 403/);
  // Not a proxy request at all.
  assert.match(await via("/direct"), /^HTTP\/1\.1 400/);
});

test("names resolving to blocked addresses are refused, even when allowed", async (t) => {
  const { upstreamPort, proxyPort } = await setup(t, ["internal.example.com", "nowhere.test"], {
    blocked: () => true,
  });
  const answer = await raw(
    proxyPort,
    `CONNECT internal.example.com:${upstreamPort} HTTP/1.1\r\n\r\n`,
  );
  assert.match(answer, /^HTTP\/1\.1 403[^]*resolves to a private address/);
  const unknown = await raw(proxyPort, `CONNECT nowhere.test:443 HTTP/1.1\r\n\r\n`);
  assert.match(unknown, /^HTTP\/1\.1 502[^]*could not resolve nowhere\.test/);
});

test("address check: loopback, link-local, metadata always; private only by name", () => {
  for (const ip of [
    "127.0.0.1",
    "0.0.0.0",
    "169.254.169.254",
    "::1",
    "::",
    "fe80::1",
    "::ffff:127.0.0.1",
    "224.0.0.1",
  ]) {
    assert.equal(blockedAddress(ip, true), true, ip);
  }
  for (const ip of [
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.1",
    "192.168.1.1",
    "100.64.0.1",
    "fd00::1",
  ]) {
    assert.equal(blockedAddress(ip, false), true, ip);
    assert.equal(blockedAddress(ip, true), false, ip);
  }
  for (const ip of ["140.82.112.3", "172.32.0.1", "2606:4700::1", "::ffff:8.8.8.8"]) {
    assert.equal(blockedAddress(ip, false), false, ip);
  }
  assert.equal(blockedAddress("not-an-ip", true), true);
});

test("address check: IPv6 forms of refused addresses are refused", () => {
  for (const ip of [
    "::ffff:a9fe:a9fe",
    "::ffff:7f00:1",
    "::FFFF:7F00:0001",
    "0:0:0:0:0:0:0:1",
    "0000:0000:0000:0000:0000:0000:0000:0000",
    "0:0:0:0:0:ffff:7f00:1",
    "::7f00:1",
    "::127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::127.0.0.1",
    "fe80::1%eth0",
    "febf::1",
    "fec0::1",
    "ff02::1",
    // Benchmarking, and IPv4 addresses behind IPv4-translated and 6to4 ones.
    "198.18.0.1",
    "198.19.255.254",
    "::ffff:0:a9fe:a9fe",
    "::ffff:0:127.0.0.1",
    "2002:7f00:1::",
    "2002:a9fe:a9fe:1::1",
  ]) {
    assert.equal(blockedAddress(ip, true), true, ip);
  }
  for (const ip of [
    "::ffff:0a00:0001",
    "::ffff:c0a8:101",
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
    "fc00::1",
    "FD12:3456::1",
    "::ffff:0:a00:1",
    "2002:ac11:1::1",
  ]) {
    assert.equal(blockedAddress(ip, false), true, ip);
    assert.equal(blockedAddress(ip, true), false, ip);
  }
  for (const ip of [
    "2606:4700::1",
    "2001:4860:4860:0:0:0:0:8888",
    "2a00:1450:4007:80e::200e",
    "::ffff:808:808",
    "64:ff9b::808:808",
    "fe00::1",
    "198.20.0.1",
    "2002:808:808::1",
  ]) {
    assert.equal(blockedAddress(ip, false), false, ip);
  }
});

test("IPv6 addresses as bytes", () => {
  const loopback = [...Array(15).fill(0), 1];
  assert.deepEqual(v6Bytes("::1"), loopback);
  assert.deepEqual(v6Bytes("0:0:0:0:0:0:0:1"), loopback);
  assert.deepEqual(v6Bytes("::ffff:a9fe:a9fe"), v6Bytes("::ffff:169.254.169.254"));
  assert.deepEqual(v6Bytes("1::"), [0, 1, ...Array(14).fill(0)]);
  assert.equal(v6Bytes("127.0.0.1"), null);
  assert.equal(v6Bytes("not-an-ip"), null);
});

test("CONNECT to a hex IPv4-mapped literal is refused", async (t) => {
  const proxy = createProxy({ policy: async () => ({ allowed: true, private: false }) });
  await listening(proxy);
  t.after(() => proxy.close());
  const answer = await raw(proxy.address().port, "CONNECT [::ffff:7f00:1]:80 HTTP/1.1\r\n\r\n");
  assert.match(answer, /^HTTP\/1\.1 403[^]*private address/);
});

test("CONNECT targets", () => {
  assert.deepEqual(target("GitHub.com:443"), { host: "github.com", port: 443 });
  assert.deepEqual(target("[2606:4700::1]:443"), { host: "2606:4700::1", port: 443 });
  assert.equal(target("github.com"), null);
  assert.equal(target("github.com:0"), null);
  assert.equal(target("a:b:443"), null);
});

test("the listener's policy: its answer, or refused when it can't answer", async (t) => {
  const asked = [];
  const { url } = await serve(t, (req, res) => {
    asked.push(req.url);
    if (req.url.includes("broken")) return res.writeHead(500).end();
    const cache = req.url.includes("cached");
    const decrypt = req.url.includes("decrypt");
    res.end(JSON.stringify({ allowed: req.url.includes("good"), private: true, cache, decrypt }));
  });
  const policy = listenerPolicy(`${url}/egress`);
  assert.deepEqual(await policy("10.0.0.5", "good.com"), {
    allowed: true,
    private: true,
    cache: false,
    decrypt: false,
  });
  assert.equal((await policy("10.0.0.5", "good.cached.com")).cache, true);
  assert.equal((await policy("10.0.0.5", "good.cached.com")).decrypt, false);
  assert.equal((await policy("10.0.0.5", "good.cached.decrypt.com")).decrypt, true);
  assert.equal((await policy("10.0.0.5", "bad.com")).allowed, false);
  assert.equal((await policy("10.0.0.5", "broken.com")).allowed, false);
  assert.equal(asked[0], "/egress?ip=10.0.0.5&host=good.com");
  const down = listenerPolicy("http://127.0.0.1:1/egress", 500);
  assert.equal((await down("10.0.0.5", "good.com")).allowed, false);
});
