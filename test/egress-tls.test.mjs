// HTTPS through the egress proxy: CONNECTs to cached hosts end in the proxy (Deckhand's CA,
// proxy/authority.mjs, made with the real openssl CLI in a temp dir) and go through the cache;
// every other one stays a raw tunnel. The upstream is a local HTTPS server whose certificates
// come from a CA of its own, standing for the public ones.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { test } from "node:test";
import { connect as tlsConnect, createSecureContext } from "node:tls";
import { createAuthority } from "../proxy/authority.mjs";
import { createCache } from "../proxy/cache.mjs";
import { createProxy } from "../proxy/proxy.mjs";
import { listening, serve, tempDir } from "./helpers.mjs";

// `t` null: the file's, removed when it ends.
const temp = (t, name) => tempDir(t, `deckhand-${name}-`);

// The upstream's CA, made once for every test: openssl takes a moment.
const publicCa = createAuthority({ dir: temp(null, "public-ca") });
await publicCa.ready();
const nameOf = (pem) => new X509Certificate(pem).subject.replace(/^CN=/, "");

// `decrypt`: the listener's answer for cached.test, false for a container engine's address.
async function setup(
  t,
  { upstreamCa = publicCa.certificate(), cacheOn = true, decrypt = true } = {},
) {
  const seen = [];
  const contexts = {};
  for (const host of ["cached.test", "other.test"]) {
    contexts[host] = createSecureContext(await publicCa.certFor(host));
  }
  const upstream = createHttpsServer(
    { SNICallback: (name, done) => done(null, contexts[name] ?? contexts["other.test"]) },
    (req, res) => {
      seen.push({ url: req.url, host: req.headers.host });
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "max-age=60" });
      res.end(`body of ${req.url}`);
    },
  );
  const upstreamPort = await listening(upstream);
  // Plain HTTP on a cached host's tunnel: no TLS, so no interception.
  const { port: plainPort } = await serve(t, (req, res) => res.end(`plain ${req.url}`));
  const asked = [];
  const authority = createAuthority({ dir: join(temp(t, "egress"), "ca") });
  await authority.ready();
  const proxy = createProxy({
    policy: async (ip, host) => {
      asked.push(host);
      const cache = host === "cached.test";
      return { allowed: true, private: true, cache, decrypt: cache && decrypt };
    },
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    blocked: () => false,
    cache: createCache({ dir: temp(t, "egress-cache"), max: cacheOn ? 1024 * 1024 : 0 }),
    authority,
    upstreamCa,
  });
  const proxyPort = await listening(proxy);
  t.after(() => {
    proxy.close();
    upstream.close();
  });

  // CONNECT host:port through the proxy → the tunnel's socket.
  const tunnel = (host, port) =>
    new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: proxyPort,
        method: "CONNECT",
        path: `${host}:${port}`,
      });
      req.on("connect", (res, socket) =>
        res.statusCode === 200 ? resolve(socket) : reject(new Error(`${res.statusCode}`)),
      );
      req.on("error", reject);
      req.end();
    });

  // GET https://host/path through a tunnel, trusting `ca` → { status, headers, body, issuer }.
  async function get(host, path, ca) {
    const raw = await tunnel(host, upstreamPort);
    const socket = tlsConnect({ socket: raw, servername: host, ca });
    await new Promise((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    const issuer = socket.getPeerCertificate().issuer.CN;
    return new Promise((resolve, reject) => {
      const req = request(
        { createConnection: () => socket, path, headers: { host, connection: "close" } },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (body += d));
          res.on("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, body, issuer }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  return { get, tunnel, seen, asked, authority, proxyPort, plainPort, upstreamPort };
}

test("HTTPS to a cached host: decrypted with Deckhand's CA, and the second GET is a hit", async (t) => {
  const { get, seen, authority, upstreamPort } = await setup(t);
  const ca = authority.certificate();
  const first = await get("cached.test", "/pkg.tgz", ca);
  assert.equal(first.status, 200);
  assert.equal(first.body, "body of /pkg.tgz");
  assert.equal(first.headers["x-deckhand-cache"], "miss");
  assert.equal(first.issuer, nameOf(ca));
  // The cache writes behind the client: give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await get("cached.test", "/pkg.tgz", ca);
  assert.equal(second.body, "body of /pkg.tgz");
  assert.equal(second.headers["x-deckhand-cache"], "hit");
  assert.deepEqual(seen, [{ url: "/pkg.tgz", host: `cached.test:${upstreamPort}` }]);
});

test("other hosts, or the cache off: a raw tunnel, with the real server's certificate", async (t) => {
  const { get, seen, authority } = await setup(t);
  const other = await get("other.test", "/x", publicCa.certificate());
  assert.equal(other.body, "body of /x");
  assert.equal(other.headers["x-deckhand-cache"], undefined);
  assert.equal(other.issuer, nameOf(publicCa.certificate()));
  assert.deepEqual(seen, [{ url: "/x", host: "other.test" }]);
  // Trusting the proxy's CA only, the client refuses it: the proxy isn't in between.
  await assert.rejects(get("other.test", "/x", authority.certificate()));

  const off = await setup(t, { cacheOn: false });
  const direct = await off.get("cached.test", "/y", publicCa.certificate());
  assert.equal(direct.headers["x-deckhand-cache"], undefined);
  assert.equal(direct.issuer, nameOf(publicCa.certificate()));

  // A cached host, from a container engine: its HTTPS isn't decrypted.
  const engine = await setup(t, { decrypt: false });
  const tunnelled = await engine.get("cached.test", "/z", publicCa.certificate());
  assert.equal(tunnelled.headers["x-deckhand-cache"], undefined);
  assert.equal(tunnelled.issuer, nameOf(publicCa.certificate()));
});

test("an upstream certificate that doesn't verify is refused, not passed on", async (t) => {
  // The proxy trusts some other CA: the upstream's certificate doesn't verify.
  const someCa = createAuthority({ dir: temp(t, "some-ca") });
  await someCa.ready();
  const { get, seen, authority } = await setup(t, { upstreamCa: someCa.certificate() });
  const answer = await get("cached.test", "/pkg.tgz", authority.certificate());
  assert.equal(answer.status, 502);
  assert.match(answer.body, /refused cached\.test's certificate/);
  assert.equal(seen.length, 0);
});

test("a cached host's tunnel that doesn't start with TLS is passed on as is", async (t) => {
  const { tunnel, plainPort } = await setup(t);
  const socket = await tunnel("cached.test", plainPort);
  socket.write("GET /raw HTTP/1.1\r\nhost: cached.test\r\nconnection: close\r\n\r\n");
  let text = "";
  for await (const chunk of socket) text += chunk;
  assert.match(text, /^HTTP\/1\.1 200/);
  assert.match(text, /plain \/raw$/);
});

test("the CA's certificate is served at /deckhand-ca.crt; none with the cache off", async (t) => {
  const { proxyPort, authority } = await setup(t);
  const res = await fetch(`http://127.0.0.1:${proxyPort}/deckhand-ca.crt`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), authority.certificate());

  const none = createProxy({ policy: async () => ({ allowed: false }) });
  const port = await listening(none);
  t.after(() => none.close());
  assert.equal((await fetch(`http://127.0.0.1:${port}/deckhand-ca.crt`)).status, 404);
});

test("the CA: made once, kept across restarts; host certificates reused, then renewed", async (t) => {
  const dir = temp(t, "ca");
  const calls = [];
  const clock = { now: Date.now() };
  const openssl = async (args) => {
    calls.push(args.includes("-CA") ? "host" : "ca");
    execFileSync("openssl", args, { stdio: "ignore" });
  };
  const first = createAuthority({ dir, openssl, now: () => clock.now });
  await first.ready();
  const cert = await first.certFor("registry.npmjs.org");
  assert.equal((await first.certFor("registry.npmjs.org")).cert, cert.cert);
  assert.deepEqual(calls, ["ca", "host"]);
  assert.match(readFileSync(join(dir, "ca.crt"), "utf8"), /BEGIN CERTIFICATE/);

  // A restart: the same CA, the host's certificate from disk.
  const again = createAuthority({ dir, openssl, now: () => clock.now });
  await again.ready();
  assert.equal(again.certificate(), first.certificate());
  assert.equal((await again.certFor("registry.npmjs.org")).cert, cert.cert);
  assert.deepEqual(calls, ["ca", "host"]);

  // Six days later, a day from its end: a new one.
  clock.now += 6 * 24 * 3600 * 1000;
  assert.notEqual((await again.certFor("registry.npmjs.org")).cert, cert.cert);
  assert.deepEqual(calls, ["ca", "host", "host"]);

  // Never a name that isn't one.
  await assert.rejects(again.certFor("a b\nsubjectAltName = DNS:*"), /no certificate/);
  await assert.rejects(again.certFor("../x"), /no certificate/);
});
