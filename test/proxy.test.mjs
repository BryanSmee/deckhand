// The egress proxy against local servers: a fake policy decides, a fake DNS points names at
// 127.0.0.1 (which the real address check refuses, so tests decide that too).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { blockedAddress, createProxy, listenerPolicy, target } from "../proxy/proxy.mjs";

async function listening(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

// An upstream web server, and a proxy allowing `allowed` hosts (all resolving to it).
async function setup(t, allowed, { blocked = () => false } = {}) {
  const upstream = createServer((req, res) =>
    res.end(`upstream ${req.method} ${req.url} host=${req.headers.host}`),
  );
  const upstreamPort = await listening(upstream);
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
  t.after(() => {
    proxy.close();
    upstream.close();
  });
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

test("CONNECT targets", () => {
  assert.deepEqual(target("GitHub.com:443"), { host: "github.com", port: 443 });
  assert.deepEqual(target("[2606:4700::1]:443"), { host: "2606:4700::1", port: 443 });
  assert.equal(target("github.com"), null);
  assert.equal(target("github.com:0"), null);
  assert.equal(target("a:b:443"), null);
});

test("the listener's policy: its answer, or refused when it can't answer", async (t) => {
  const asked = [];
  const listener = createServer((req, res) => {
    asked.push(req.url);
    if (req.url.includes("broken")) return res.writeHead(500).end();
    res.end(JSON.stringify({ allowed: req.url.includes("good"), private: true }));
  });
  const port = await listening(listener);
  t.after(() => listener.close());
  const policy = listenerPolicy(`http://127.0.0.1:${port}/egress`);
  assert.deepEqual(await policy("10.0.0.5", "good.com"), { allowed: true, private: true });
  assert.equal((await policy("10.0.0.5", "bad.com")).allowed, false);
  assert.equal((await policy("10.0.0.5", "broken.com")).allowed, false);
  assert.equal(asked[0], "/egress?ip=10.0.0.5&host=good.com");
  const down = listenerPolicy("http://127.0.0.1:1/egress", 500);
  assert.equal((await down("10.0.0.5", "good.com")).allowed, false);
});
