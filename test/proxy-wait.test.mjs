// The egress proxy waiting for the orchestrator or a service that restarts (proxy/wait.mjs): a
// connection that wasn't made is tried again, with an injected clock, for up to 5 minutes; any
// other failure, a request already sent among them, is not.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { DRAIN_MS } from "../lib/drain.mjs";
import { SANDBOX_URLS } from "../lib/services.mjs";
import { createProxy, EARLY_MAX, egressPolicy } from "../proxy/proxy.mjs";
import { LISTENER_WAIT_MS, notReached, untilReached } from "../proxy/wait.mjs";
import { closedPort, listening, listenToRestart, serve } from "./helpers.mjs";

// A clock that only moves when the code sleeps.
function fakeClock() {
  const clock = { t: 0, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.t += ms;
  };
  return clock;
}

const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

test("a refused connection is tried again, with a growing delay, until the listener answers", async () => {
  const clock = fakeClock();
  let tries = 0;
  const answer = await untilReached(async () => {
    if (++tries < 5) throw refused();
    return "answered";
  }, clock);
  assert.equal(answer, "answered");
  assert.equal(tries, 5);
  assert.deepEqual(clock.sleeps, [250, 500, 1000, 2000]);
});

test("the wait gives up after 5 minutes, the listener's drain and a start, with the last error", async () => {
  const clock = fakeClock();
  let tries = 0;
  await assert.rejects(
    untilReached(async () => {
      tries++;
      throw refused();
    }, clock),
    /ECONNREFUSED/,
  );
  assert.equal(LISTENER_WAIT_MS, 300_000);
  assert.ok(LISTENER_WAIT_MS > DRAIN_MS);
  assert.equal(clock.t, 300_000);
  // The delay stops growing at 5 s: about sixty-five tries.
  assert.ok(tries > 55 && tries < 75, `${tries} tries`);
  assert.ok(clock.sleeps.every((ms) => ms <= 5000));
});

test("any other failure isn't tried again: a request sent, an error answer, a timeout", async () => {
  const clock = fakeClock();
  for (const error of [
    Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    new Error("500"),
    Object.assign(new Error("timeout"), { name: "TimeoutError" }),
  ]) {
    let tries = 0;
    await assert.rejects(
      untilReached(async () => {
        tries++;
        throw error;
      }, clock),
      error,
    );
    assert.equal(tries, 1);
  }
  assert.equal(clock.t, 0);
  // A caller that left: not tried again either.
  let tries = 0;
  await assert.rejects(
    untilReached(
      async () => {
        tries++;
        throw refused();
      },
      { ...clock, gone: () => true },
    ),
  );
  assert.equal(tries, 1);
});

test("what counts as not reached: refused, reset while connecting, no such host; fetch's too", () => {
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH"]) {
    assert.equal(notReached({ code }), true, code);
    assert.equal(notReached(new TypeError("fetch failed", { cause: { code } })), true, code);
  }
  assert.equal(notReached({ code: "EPIPE" }), false);
  assert.equal(notReached(new Error("x")), false);
  assert.equal(notReached(undefined), false);
});

test("the policy waits for the listener rather than refusing every host", async (t) => {
  // The listener's port, closed: it listens again at the second wait.
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(req.url);
    res.end(JSON.stringify({ allowed: true, relay: true }));
  });
  const port = await listenToRestart(server);
  t.after(() => server.close());
  await new Promise((resolve) => server.close(resolve));
  const clock = fakeClock();
  const sleep = clock.sleep;
  clock.sleep = async (ms) => {
    await sleep(ms);
    if (clock.sleeps.length === 2)
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  };
  const policy = egressPolicy(`http://127.0.0.1:${port}/egress`, 5000, clock);
  assert.deepEqual(await policy("10.0.0.2", "api.github.com"), {
    allowed: true,
    private: false,
    cache: false,
    decrypt: false,
    relay: true,
    models: false,
    sandbox: null,
    service: null,
  });
  assert.deepEqual(asked, ["/egress?ip=10.0.0.2&host=api.github.com"]);
  assert.equal(clock.sleeps.length, 2);

  // Gone for good: refused after 5 minutes, as a listener that says no.
  await new Promise((resolve) => server.close(resolve));
  const later = fakeClock();
  const gone = egressPolicy(`http://127.0.0.1:${port}/egress`, 5000, later);
  assert.deepEqual(await gone("10.0.0.2", "api.github.com"), {
    allowed: false,
    reason: "policy_error",
  });
  assert.equal(later.t, LISTENER_WAIT_MS);
});

test("a client that left stops the policy's wait: no question for nobody", async (t) => {
  const port = await closedPort();
  const url = `http://127.0.0.1:${port}/egress`;
  const clock = fakeClock();
  const policy = egressPolicy(url, 5000, clock);
  assert.deepEqual(await policy("10.0.0.2", "x.test", { gone: () => true }), {
    allowed: false,
    reason: "policy_error",
  });
  assert.equal(clock.t, 0);

  // Through the proxy: a CONNECT whose client hangs up while the listener is down.
  let sleeps = 0;
  const proxy = createProxy({
    policy: egressPolicy(url, 5000, {
      sleep: () => (sleeps++, new Promise((resolve) => setTimeout(resolve, 10))),
    }),
  });
  const proxyPort = await listening(proxy);
  t.after(() => proxy.close());
  const client = connect(proxyPort, "127.0.0.1");
  await new Promise((resolve) => client.once("connect", resolve));
  client.write("CONNECT x.test:443 HTTP/1.1\r\nhost: x.test:443\r\n\r\n");
  while (!sleeps) await new Promise((resolve) => setTimeout(resolve, 5));
  client.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = sleeps;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sleeps, after);
});

test("what a CONNECT's client sends before its answer is capped while the policy waits", async (t) => {
  const port = await closedPort();
  const proxy = createProxy({
    policy: egressPolicy(`http://127.0.0.1:${port}/egress`, 5000, {
      sleep: () => new Promise((resolve) => setTimeout(resolve, 10)),
    }),
  });
  const proxyPort = await listening(proxy);
  t.after(() => proxy.close());
  const client = connect(proxyPort, "127.0.0.1");
  client.on("error", () => {});
  const closed = new Promise((resolve) => client.once("close", resolve));
  await new Promise((resolve) => client.once("connect", resolve));
  client.write("CONNECT x.test:443 HTTP/1.1\r\nhost: x.test:443\r\n\r\n");
  // A ClientHello's worth is kept; past EARLY_MAX, the client is cut, the listener still down.
  client.write(Buffer.alloc(4096));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.destroyed, false);
  client.write(Buffer.alloc(EARLY_MAX));
  await closed;
});

// A plain HTTP request through the proxy at `proxyPort` → { status, body }.
function viaProxy(proxyPort, url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: proxyPort, method, path: url, headers },
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

test("sandboxes' calls to a service's name go to it through the proxy, waiting for a restarting service", async (t) => {
  // The github service's port, closed until the second wait (an injected clock).
  const got = [];
  const service = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      got.push({ method: req.method, url: req.url, body, headers: req.headers });
      // A service that dies once it has the request: nothing comes back.
      if (body === "die") return req.socket.destroy();
      res.end("done");
    });
  });
  const port = await listenToRestart(service);
  const url = `http://127.0.0.1:${port}`;
  t.after(() => service.close());
  await new Promise((resolve) => service.close(resolve));
  const clock = fakeClock();
  const sleep = clock.sleep;
  clock.sleep = async (ms) => {
    await sleep(ms);
    if (clock.sleeps.length === 2)
      await new Promise((resolve) => service.listen(port, "127.0.0.1", resolve));
  };
  // The orchestrator's policy: the services' names for its sandbox (127.0.0.1) when the proxy
  // forwards them, nothing else.
  const asked = [];
  const proxy = createProxy({
    policy: async (ip, host, { forward } = {}) => {
      asked.push([ip, host, forward === true]);
      return { allowed: forward === true && ip === "127.0.0.1", sandbox: "net-1" };
    },
    githubService: { url, header: async () => "Bearer proxy" },
    wait: clock,
  });
  const proxyPort = await listening(proxy);
  t.after(() => proxy.close());

  // A push: sent once the service is back, body and all, naming the sandbox's network
  // (whatever it said itself), once the policy said the name is the sandbox's to reach.
  const github = SANDBOX_URLS.github;
  const push = await viaProxy(proxyPort, `${github}/git/org/repo.git/git-receive-pack`, {
    method: "POST",
    headers: {
      "x-deckhand-client": "10.9.9.9",
      "x-deckhand-sandbox": "net-9",
      "proxy-authorization": "x",
    },
    body: "pack",
  });
  assert.deepEqual(push, { status: 200, body: "done" });
  assert.equal(got.length, 1);
  assert.equal(got[0].method, "POST");
  assert.equal(got[0].url, "/git/org/repo.git/git-receive-pack");
  assert.equal(got[0].body, "pack");
  assert.equal(got[0].headers["x-deckhand-sandbox"], "net-1");
  assert.equal(got[0].headers["x-deckhand-client"], undefined);
  assert.equal(got[0].headers.host, `127.0.0.1:${port}`);
  assert.equal(got[0].headers["proxy-authorization"], undefined);
  assert.equal(clock.sleeps.length, 2);
  assert.deepEqual(asked, [["127.0.0.1", "github", true]]);

  // A request the service got before it died isn't sent again: the sandbox hears it.
  got.length = 0;
  const cut = await viaProxy(proxyPort, `${github}/git/org/repo.git/git-receive-pack`, {
    method: "POST",
    body: "die",
  });
  assert.equal(cut.status, 502);
  assert.match(cut.body, /could not reach the github service/);
  assert.equal(got.length, 1);

  // Another port on the name isn't the service: an ordinary host, the policy decides.
  asked.length = 0;
  got.length = 0;
  const other = await viaProxy(proxyPort, "http://github:9999/git/org/repo.git");
  assert.equal(other.status, 403);
  assert.deepEqual(asked, [["127.0.0.1", "github", false]]);
  assert.deepEqual(got, []);
});

test("a path to a service never names another host", async (t) => {
  // The github service, and another host on the same machine, which nothing may reach this way.
  const got = [];
  const { url } = await serve(t, (req, res) => (got.push(req.url), res.end("github")));
  const elsewhere = [];
  const { port: otherPort } = await serve(t, (req, res) => (elsewhere.push(req.url), res.end()));
  const proxy = createProxy({
    policy: async () => ({ allowed: true }),
    githubService: { url, header: async () => "Bearer proxy" },
  });
  const proxyPort = await listening(proxy);
  t.after(() => proxy.close());
  const github = SANDBOX_URLS.github;
  // Read as URLs, these paths would name localhost:<otherPort>.
  for (const path of [`/git//localhost:${otherPort}/x`, `/git/a/..//localhost:${otherPort}/x`]) {
    const answer = await viaProxy(proxyPort, `${github}${path}`);
    assert.equal(answer.status, 200, path);
    assert.equal(answer.body, "github", path);
  }
  // The service got them as paths of its own; one outside its sandboxes' paths goes nowhere.
  assert.equal((await viaProxy(proxyPort, `${github}//localhost:${otherPort}/x`)).status, 404);
  assert.deepEqual(got, [`/git//localhost:${otherPort}/x`, `/git//localhost:${otherPort}/x`]);
  assert.deepEqual(elsewhere, []);
});

test("a service's name through the proxy only for whom the policy allows: a build or an install, refused", async (t) => {
  const got = [];
  const { url } = await serve(t, (req, res) => (got.push(req.url), res.end()));
  const proxy = createProxy({
    policy: async () => ({ allowed: false }),
    modelsService: { url, header: async () => "Bearer proxy" },
  });
  const proxyPort = await listening(proxy);
  t.after(() => proxy.close());
  const answer = await viaProxy(proxyPort, `${SANDBOX_URLS.models}/anthropic/v1/messages`, {
    method: "POST",
  });
  assert.equal(answer.status, 403);
  assert.match(answer.body, /only a running sandbox reaches the models service/);
  assert.deepEqual(got, []);
});
