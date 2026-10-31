// HTTPS through the egress proxy: CONNECTs to cached hosts end in the proxy (Deckhand's CA,
// proxy/authority.mjs, made with the real openssl CLI in a temp dir) and go through the cache;
// every other one stays a raw tunnel. The upstream is a local HTTPS server whose certificates
// come from a CA of its own, standing for the public ones.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { Duplex } from "node:stream";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { test } from "node:test";
import { connect as tlsConnect, createSecureContext } from "node:tls";
import { CA_DAYS, certifiable, createAuthority } from "../proxy/authority.mjs";
import { createCache } from "../proxy/cache.mjs";
import { createProxy, relayTarget } from "../proxy/proxy.mjs";
import { listening, serve, tempDir } from "./helpers.mjs";

// `t` null: the file's, removed when it ends.
const temp = (t, name) => tempDir(t, `deckhand-${name}-`);

// The upstream's CA, made once for every test: openssl takes a moment.
const publicCa = createAuthority({ dir: temp(null, "public-ca") });
await publicCa.ready();
const nameOf = (pem) => new X509Certificate(pem).subject.replace(/^CN=/, "");

// `decrypt`: the listener's answer for cached.test, false for a container engine's address.
// relayed.test is relayed to `relayUrl` (the listener's /relay).
async function setup(
  t,
  {
    upstreamCa = publicCa.certificate(),
    cacheOn = true,
    decrypt = true,
    relayUrl = null,
    githubService = null,
    modelsService = null,
    wait = {},
    held = null, // a promise the policy's answers wait for (a listener slow to answer)
  } = {},
) {
  const seen = [];
  // Each request's headers, as the host got them.
  const heard = [];
  const contexts = {};
  for (const host of ["cached.test", "other.test", "agent.test"]) {
    contexts[host] = createSecureContext(await publicCa.certFor(host));
  }
  const upstream = createHttpsServer(
    { SNICallback: (name, done) => done(null, contexts[name] ?? contexts["other.test"]) },
    (req, res) => {
      seen.push({ url: req.url, host: req.headers.host });
      heard.push(req.headers);
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
      await held;
      const cache = host === "cached.test";
      // GitHub's, to the github service, with the run's network the listener vouches for;
      // agent.test: an agent's relayed host, whose calls are the models service's.
      const github = host === "github.test";
      const models = host === "agent.test";
      const relay = host === "relayed.test" || github || models;
      return {
        allowed: true,
        private: true,
        cache,
        decrypt: (cache && decrypt) || relay,
        relay,
        ...(github && { service: "github", sandbox: "net-1" }),
        ...(models && { models: true, sandbox: "net-agy" }),
      };
    },
    // A relayed host is never resolved: its requests go to the listener.
    lookup: async (host) => {
      if (["relayed.test", "github.test", "agent.test"].includes(host))
        throw new Error(`${host} resolved`);
      return [{ address: "127.0.0.1", family: 4 }];
    },
    blocked: () => false,
    cache: createCache({ dir: temp(t, "egress-cache"), max: cacheOn ? 1024 * 1024 : 0 }),
    authority,
    upstreamCa,
    relayUrl,
    githubService,
    modelsService,
    wait,
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

  // GET https://host/path through a tunnel, trusting `ca`, with `headers` →
  // { status, headers, body, issuer }.
  async function get(host, path, ca, headers = {}) {
    const raw = await tunnel(host, upstreamPort);
    const socket = tlsConnect({ socket: raw, servername: host, ca });
    await new Promise((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    const issuer = socket.getPeerCertificate().issuer.CN;
    return new Promise((resolve, reject) => {
      const req = request(
        {
          createConnection: () => socket,
          path,
          headers: { host, connection: "close", ...headers },
        },
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

  return { get, tunnel, seen, heard, asked, authority, proxy, proxyPort, plainPort, upstreamPort };
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

test("a cached host's request never names a client: only a relayed one does", async (t) => {
  // Decrypted to be cached, but with a credential: sent on as is, past the cache.
  const { get, heard, authority } = await setup(t);
  const answer = await get("cached.test", "/x", authority.certificate(), {
    "x-deckhand-client": "10.9.0.7",
    authorization: "Bearer mine",
  });
  assert.equal(answer.status, 200);
  assert.equal(heard.length, 1);
  assert.equal(heard[0]["x-deckhand-client"], undefined);
  assert.equal(heard[0].authorization, "Bearer mine");
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

test("a relayed host: decrypted, cache on or off, each request to the listener instead", async (t) => {
  const relayed = [];
  const listener = await serve(t, (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      relayed.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(201, { "content-type": "text/event-stream" });
      res.end("data: relayed\n\n");
    });
  });
  for (const cacheOn of [true, false]) {
    relayed.length = 0;
    const { get, seen, authority, proxyPort } = await setup(t, {
      cacheOn,
      relayUrl: `${listener.url}/relay`,
    });
    // The sandbox can't name another address than its own.
    const answer = await get(
      "relayed.test",
      "/v1internal:streamGenerateContent?alt=sse",
      authority.certificate(),
      { "x-deckhand-client": "10.9.0.7" },
    );
    assert.equal(answer.status, 201);
    assert.equal(answer.body, "data: relayed\n\n");
    assert.equal(answer.issuer, nameOf(authority.certificate()));
    assert.equal(answer.headers["x-deckhand-cache"], undefined);
    // To the listener, the host in the path; never to the host itself.
    assert.equal(relayed.length, 1);
    assert.equal(relayed[0].url, "/relay/relayed.test/v1internal:streamGenerateContent?alt=sse");
    assert.equal(relayed[0].headers.host, new URL(listener.url).host);
    // With the address of the sandbox it came from, which the listener binds secrets to.
    assert.equal(relayed[0].headers["x-deckhand-client"], "127.0.0.1");
    assert.equal(seen.length, 0);

    // Its plain HTTP is refused: a relayed host has no address to go to.
    const plain = await new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: proxyPort, path: "http://relayed.test/x" },
        (res) => (res.resume(), resolve(res.statusCode)),
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(plain, 403);

    // A path that climbs out of /relay/<host>/ never reaches the listener: its /egress would
    // answer the proxy's address.
    for (const path of [
      "/../../egress?ip=10.0.0.2&host=x.test",
      "/%2e%2e/%2E%2E/egress?ip=10.0.0.2&host=x.test",
      "/.%2e/egress",
      "/\\..\\egress",
    ]) {
      const refused = await get("relayed.test", path, authority.certificate());
      assert.equal(refused.status, 400, path);
    }
    assert.equal(relayed.length, 1);
  }

  // No relay URL (or no CA): refused, never a tunnel that would reach the host.
  const nowhere = await setup(t);
  await assert.rejects(nowhere.tunnel("relayed.test", 443), /403/);
});

test("GitHub's relayed hosts go to the github service: the run's credential apart, its network vouched for", async (t) => {
  const heard = [];
  const answer = (req, res) => {
    heard.push({ url: req.url, headers: req.headers });
    res.end("ok");
  };
  const listener = await serve(t, answer);
  const github = await serve(t, answer);
  const { get, authority } = await setup(t, {
    relayUrl: `${listener.url}/relay`,
    githubService: { url: github.url, header: async () => "Bearer proxy-token" },
  });
  const res = await get("github.test", "/repos/o/r?x=1", authority.certificate(), {
    authorization: "token run-token",
    // What a sandbox says of itself goes nowhere.
    "x-deckhand-sandbox": "net-other",
    "x-deckhand-run-authorization": "token other",
  });
  assert.equal(res.body, "ok");
  assert.equal(heard.length, 1);
  const [{ url, headers }] = heard;
  assert.equal(url, "/relay/github.test/repos/o/r?x=1");
  assert.equal(headers.host, new URL(github.url).host);
  assert.equal(headers.authorization, "Bearer proxy-token");
  assert.equal(headers["x-deckhand-run-authorization"], "token run-token");
  assert.equal(headers["x-deckhand-sandbox"], "net-1");
  // The agents' relayed hosts still go to the listener.
  await get("relayed.test", "/v1/x", authority.certificate());
  assert.equal(heard.at(-1).url, "/relay/relayed.test/v1/x");
  assert.equal(heard.at(-1).headers.host, new URL(listener.url).host);
});

test("a relayed host to an https: listener: over verified TLS, one connection per request", async (t) => {
  const relayed = [];
  const listener = createHttpsServer({ ...(await publicCa.certFor("localhost")) }, (req, res) => {
    relayed.push({ url: req.url, connection: req.headers.connection });
    res.end("over TLS");
  });
  const port = await listening(listener);
  t.after(() => listener.close());
  const { get, authority } = await setup(t, { relayUrl: `https://localhost:${port}/relay` });
  const answer = await get("relayed.test", "/v1/x", authority.certificate(), {
    connection: "keep-alive",
    "keep-alive": "timeout=60",
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body, "over TLS");
  // The listener's connection closes, not the client's.
  assert.notEqual(answer.headers.connection, "close");
  // The client's keep-alive isn't passed on: the connection, not pooled, closes once answered.
  assert.deepEqual(relayed, [{ url: "/relay/relayed.test/v1/x", connection: "close" }]);
});

test("a relayed host while the listener restarts: waited for, sent once, never again", async (t) => {
  // The listener's port, closed until the second wait (an injected clock).
  const relayed = [];
  const { server: listener, url } = await serve(t, (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      relayed.push({ method: req.method, url: req.url, body });
      // A listener that dies once it has the request: nothing comes back.
      if (body === "die") return req.socket.destroy();
      res.end("done");
    });
  });
  const port = Number(new URL(url).port);
  await new Promise((resolve) => listener.close(resolve));
  const clock = { t: 0, sleeps: 0 };
  const wait = {
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      if (++clock.sleeps === 2)
        await new Promise((resolve) => listener.listen(port, "127.0.0.1", resolve));
    },
  };
  const { tunnel, authority } = await setup(t, { relayUrl: `${url}/relay`, wait });

  // POST through a tunnel to relayed.test → { status, body }.
  async function post(body) {
    const raw = await tunnel("relayed.test", 443);
    const socket = tlsConnect({
      socket: raw,
      servername: "relayed.test",
      ca: authority.certificate(),
    });
    await new Promise((resolve) => socket.once("secureConnect", resolve));
    return new Promise((resolve, reject) => {
      const req = request(
        {
          createConnection: () => socket,
          method: "POST",
          path: "/v1/push",
          headers: { host: "relayed.test", connection: "close" },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (text += d));
          res.on("end", () => resolve({ status: res.statusCode, body: text }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  // Refused twice, then the listener is back: the POST reaches it once, body and all.
  assert.deepEqual(await post("push"), { status: 200, body: "done" });
  assert.deepEqual(relayed, [{ method: "POST", url: "/relay/relayed.test/v1/push", body: "push" }]);
  assert.equal(clock.sleeps, 2);

  // A request the listener got before it died isn't sent again: the sandbox hears it.
  relayed.length = 0;
  const cut = await post("die");
  assert.equal(cut.status, 502);
  assert.match(cut.body, /could not reach the listener/);
  assert.equal(relayed.length, 1);
  assert.equal(clock.sleeps, 2);

  // Gone for good: the sandbox hears it after 5 minutes.
  await new Promise((resolve) => listener.close(resolve));
  const before = clock.t;
  const late = await post("push");
  assert.equal(late.status, 502);
  assert.equal(clock.t - before, 300_000);
});

test("a draining proxy: no new tunnel, a relayed stream in flight finishes, then it ends", async (t) => {
  let stream = null;
  const { url } = await serve(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n");
    stream = res;
  });
  const { tunnel, authority, proxy } = await setup(t, { relayUrl: `${url}/relay` });
  // A kept-alive connection inside the tunnel, as gh's or an agent's.
  const raw = await tunnel("relayed.test", 443);
  const socket = tlsConnect({
    socket: raw,
    servername: "relayed.test",
    ca: authority.certificate(),
  });
  await new Promise((resolve) => socket.once("secureConnect", resolve));
  const answer = new Promise((resolve, reject) => {
    const req = request(
      {
        createConnection: () => socket,
        path: "/v1/stream",
        headers: { host: "relayed.test", connection: "keep-alive" },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end();
  });
  while (!stream) await new Promise((resolve) => setTimeout(resolve, 5));
  // Another, with no request going: closed by the drain.
  const idle = await tunnel("relayed.test", 443);
  const idleTls = tlsConnect({
    socket: idle,
    servername: "relayed.test",
    ca: authority.certificate(),
  });
  await new Promise((resolve) => idleTls.once("secureConnect", resolve));
  const idleClosed = new Promise((resolve) => idleTls.once("close", resolve));

  let done = false;
  const drained = proxy.drain().then((all) => ((done = true), all));
  await assert.rejects(tunnel("relayed.test", 443), (error) => error.code === "ECONNREFUSED");
  await idleClosed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(done, false);
  stream.end("data: 2\n\n");
  // Its answer began before the drain, keeping the connection alive: closed once sent, which
  // ends the tunnel, the proxy's last connection.
  assert.equal((await answer).text, "data: 1\n\ndata: 2\n\n");
  assert.equal(await drained, true);
  if (!raw.destroyed) await new Promise((resolve) => raw.once("close", resolve));
});

// A CONNECT's socket for a client that doesn't wait for the 200: the bytes it reads, past that
// answer's head, as a stream TLS can start on at once.
function eager(raw) {
  let head = "";
  let past = false;
  const stream = new Duplex({
    write: (chunk, encoding, done) => raw.write(chunk, done),
    final: (done) => (raw.end(), done()),
    read() {},
  });
  raw.on("data", (chunk) => {
    if (past) return stream.push(chunk);
    head += chunk.toString("latin1");
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;
    past = true;
    assert.match(head, /^HTTP\/1\.1 200/);
    const rest = Buffer.from(head.slice(end + 4), "latin1");
    if (rest.length) stream.push(rest);
  });
  raw.on("end", () => stream.push(null));
  return stream;
}

test("what a client sends while the policy is asked goes on first: raw and decrypted tunnels", async (t) => {
  // A raw tunnel: the bytes reach the host before those sent after the 200.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const received = [];
  const host = createNetServer((socket) => socket.on("data", (d) => received.push(d.toString())));
  const hostPort = await listening(host);
  t.after(() => host.close());
  const raw = await setup(t, { held });
  const client = netConnect(raw.proxyPort, "127.0.0.1");
  t.after(() => client.destroy());
  await new Promise((resolve) => client.once("connect", resolve));
  client.write(`CONNECT plain.test:${hostPort} HTTP/1.1\r\nhost: plain.test\r\n\r\nearly-1`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  client.write("early-2");
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await new Promise((resolve) => client.once("data", resolve));
  client.write("after");
  while (received.join("") !== "early-1early-2after") {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // A decrypted one: a ClientHello sent before the 200 starts its TLS.
  let again;
  const later = new Promise((resolve) => (again = resolve));
  const { url } = await serve(t, (req, res) => res.end(`relayed ${req.url}`));
  const relayed = await setup(t, { held: later, relayUrl: `${url}/relay` });
  const socket = netConnect(relayed.proxyPort, "127.0.0.1");
  t.after(() => socket.destroy());
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write("CONNECT relayed.test:443 HTTP/1.1\r\nhost: relayed.test\r\n\r\n");
  const tls = tlsConnect({
    socket: eager(socket),
    servername: "relayed.test",
    ca: relayed.authority.certificate(),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  again();
  await new Promise((resolve, reject) => {
    tls.once("secureConnect", resolve);
    tls.once("error", reject);
  });
  const body = await new Promise((resolve, reject) => {
    const req = request(
      {
        createConnection: () => tls,
        path: "/v1/x",
        headers: { host: "relayed.test", connection: "close" },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve(text));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(body, "relayed /relay/relayed.test/v1/x");
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

test("relayTarget: only origin-form paths that stay under /relay/<host>/", () => {
  const base = "http://listener:8081/relay";
  assert.equal(
    relayTarget(base, "a.test", "/v1internal:x?alt=sse")?.href,
    "http://listener:8081/relay/a.test/v1internal:x?alt=sse",
  );
  assert.equal(relayTarget(base, "a.test", "/")?.href, "http://listener:8081/relay/a.test/");
  // Dots that are no dot segment: GitHub's compare, a search's date range, a file's name.
  for (const path of [
    "/repos/o/r/compare/main...feature",
    "/o/r/compare/v1.0..v1.1",
    "/search/issues?q=repo:o/r+created:2026-01-01..2026-02-01",
    "/search/issues?q=a/../b",
    "/repos/o/r/contents/a%2Ejs",
    "/repos/o/r/contents/.github/x.yml",
    "/a/...",
  ]) {
    assert.equal(relayTarget(base, "a.test", path)?.href, `${base}/a.test${path}`, path);
  }
  for (const path of [
    "/../../egress",
    "/%2E%2e/egress",
    "/a/%2e./b",
    "/a/..",
    "/a/./b",
    "/a/%2E",
    "/.",
    "/a\\b",
    "http://elsewhere/x",
    "*",
    "",
  ]) {
    assert.equal(relayTarget(base, "a.test", path), null, path);
  }
});

// A leaf for `name` signed with the CA's key, as a leaked key would make it, then checked by
// openssl verify against the CA alone → its output.
function forged(dir, name) {
  const run = (args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  writeFileSync(
    join(dir, `${name}.cnf`),
    `[req]\ndistinguished_name = dn\nprompt = no\n[dn]\n[leaf]\nsubjectAltName = DNS:${name}\nextendedKeyUsage = serverAuth\n`,
  );
  run([
    "req",
    "-x509",
    ...["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ...["-keyout", `${name}.key`, "-out", `${name}.crt`, "-days", "7"],
    ...["-subj", `/CN=${name}`, "-config", `${name}.cnf`, "-extensions", "leaf"],
    ...["-CA", "ca.crt", "-CAkey", "ca.key"],
  ]);
  try {
    return run(["verify", "-CAfile", "ca.crt", `${name}.crt`]).toString();
  } catch (error) {
    return `failed: ${error.stderr}${error.stdout}`;
  }
}

test("the CA can't vouch for the agents' providers, even with its key, but does for GitHub", async (t) => {
  const dir = temp(t, "ca");
  const authority = createAuthority({ dir });
  await authority.ready();
  for (const name of ["anthropic.com", "api.anthropic.com", "api.openai.com", "chatgpt.com"]) {
    assert.match(forged(dir, name), /failed: .*excluded subtree violation/s, name);
    // And the proxy never asks for one: such a host is tunnelled.
    assert.equal(certifiable(name), false);
    await assert.rejects(authority.certFor(name), /no certificate/);
  }
  assert.match(forged(dir, "registry.npmjs.org"), /: OK/);
  // Nor a name that only ends the same way.
  assert.match(forged(dir, "notanthropic.com"), /: OK/);
  assert.equal(certifiable("notanthropic.com"), true);
  // GitHub's hosts: relayed to the listener's GitHub gateway, which holds the tokens.
  for (const name of ["github.com", "api.github.com", "objects.githubusercontent.com"]) {
    assert.match(forged(dir, name), /: OK/, name);
    assert.equal(certifiable(name), true);
  }
  assert.match((await authority.certFor("api.github.com")).cert, /BEGIN CERTIFICATE/);
  // Node's TLS (OpenSSL's checks) refuses a provider's too.
  const server = createHttpsServer({
    key: readFileSync(join(dir, "api.anthropic.com.key")),
    cert: readFileSync(join(dir, "api.anthropic.com.crt")),
  });
  const port = await listening(server);
  t.after(() => server.close());
  const error = await new Promise((resolve) => {
    const socket = tlsConnect({
      port,
      host: "127.0.0.1",
      servername: "api.anthropic.com",
      ca: authority.certificate(),
    });
    socket.once("secureConnect", () => resolve(null));
    socket.once("error", resolve);
  });
  assert.match(error?.message ?? "connected", /excluded subtree violation/);
});

test("the CA lasts a year, and is made again near its end or when it predates name constraints", async (t) => {
  const dir = temp(t, "ca");
  const fresh = createAuthority({ dir });
  await fresh.ready();
  const x509 = new X509Certificate(fresh.certificate());
  const days = (Date.parse(x509.validTo) - Date.parse(x509.validFrom)) / (24 * 3600 * 1000);
  assert.ok(days >= CA_DAYS - 1 && days <= CA_DAYS + 1, `${days} days`);

  // What a CA made by openssl itself, of `days`, with `extensions` (none: name constraints).
  const replaced = async (days, extensions) => {
    const old = temp(t, "old-ca");
    writeFileSync(
      join(old, "ca.cnf"),
      `[req]\ndistinguished_name = dn\nprompt = no\n[dn]\n[ca]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign\n${extensions}\n`,
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        ...["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
        ...["-keyout", "ca.key", "-out", "ca.crt", "-days", String(days)],
        ...["-subj", "/CN=old", "-config", "ca.cnf", "-extensions", "ca"],
      ],
      { cwd: old, stdio: "ignore" },
    );
    const before = readFileSync(join(old, "ca.crt"), "utf8");
    const logged = [];
    const authority = createAuthority({ dir: old, log: (line) => logged.push(line) });
    await authority.ready();
    return { kept: authority.certificate() === before, logged, authority, old };
  };
  // Ten years without name constraints: Deckhand's CAs before them.
  const legacy = await replaced(3650, "");
  assert.equal(legacy.kept, false);
  assert.match(legacy.logged.join("\n"), /without the name constraints of now; making a new one/);
  assert.equal(readFileSync(join(legacy.old, "ca.crt"), "utf8"), legacy.authority.certificate());
  // With them, twenty days from its end: a new one too.
  const constraints = "nameConstraints = critical,excluded;DNS:anthropic.com";
  assert.equal((await replaced(20, constraints)).kept, false);
  // Months from it: kept.
  assert.equal((await replaced(200, constraints)).kept, true);
  // One that excludes GitHub, from before the GitHub gateway: made again, without that.
  for (const name of ["github.com", "githubusercontent.com"]) {
    const before = await replaced(200, `${constraints},excluded;DNS:${name}`);
    assert.equal(before.kept, false, name);
    assert.match(forged(before.old, "api.github.com"), /: OK/);
  }
});

test("a CA made again while the proxy runs: the next run's certificate, and new host certificates", async (t) => {
  const dir = temp(t, "ca");
  // Forty days from its end: current today, not in a fortnight.
  writeFileSync(
    join(dir, "ca.cnf"),
    "[req]\ndistinguished_name = dn\nprompt = no\n[dn]\n[ca]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign\nnameConstraints = critical,excluded;DNS:anthropic.com\n",
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      ...["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
      ...["-keyout", "ca.key", "-out", "ca.crt", "-days", "40"],
      ...["-subj", "/CN=old", "-config", "ca.cnf", "-extensions", "ca"],
    ],
    { cwd: dir, stdio: "ignore" },
  );
  const clock = { now: Date.now() };
  const authority = createAuthority({ dir, now: () => clock.now });
  await authority.ready();
  const first = authority.certificate();
  assert.equal(first, readFileSync(join(dir, "ca.crt"), "utf8"));
  const host = await authority.certFor("registry.npmjs.org");
  clock.now += 15 * 24 * 3600 * 1000;
  const again = await authority.certFor("registry.npmjs.org");
  assert.notEqual(authority.certificate(), first);
  assert.notEqual(again.cert, host.cert);
  assert.equal(
    new X509Certificate(again.cert).checkIssued(new X509Certificate(authority.certificate())),
    true,
  );
});

test("an agent's relayed host goes to the models service, with the proxy's token and the network it vouches for", async (t) => {
  const listener = [];
  const { url: listenerUrl } = await serve(t, (req, res) => (listener.push(req.url), res.end()));
  const heard = [];
  const { url: modelsUrl } = await serve(t, (req, res) => {
    heard.push({ url: req.url, headers: req.headers });
    req.resume();
    req.on("end", () => res.end("data: from models\n\n"));
  });
  const { get, authority } = await setup(t, {
    relayUrl: `${listenerUrl}/relay`,
    modelsService: { url: modelsUrl, header: async () => "Bearer proxy-service-token" },
  });
  const answer = await get("agent.test", "/v1internal:loadCodeAssist", authority.certificate(), {
    authorization: "Bearer the-agent-token",
    // Whatever the sandbox says of its network or token is replaced.
    "x-deckhand-sandbox": "net-other",
    "x-deckhand-run-token": "forged",
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body, "data: from models\n\n");
  assert.equal(heard.length, 1);
  assert.equal(heard[0].url, "/relay/agent.test/v1internal:loadCodeAssist");
  assert.equal(heard[0].headers.authorization, "Bearer proxy-service-token");
  assert.equal(heard[0].headers["x-deckhand-run-token"], "the-agent-token");
  assert.equal(heard[0].headers["x-deckhand-sandbox"], "net-agy");
  // Nothing went to the listener.
  assert.deepEqual(listener, []);
  // A path that climbs out of /relay/<host>/ never reaches it.
  const out = await get("agent.test", "/%2e%2e/credentials", authority.certificate());
  assert.equal(out.status, 400);
  assert.equal(heard.length, 1);
});
