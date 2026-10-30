// The egress proxy waiting for a listener that restarts (proxy/wait.mjs): a connection that
// wasn't made is tried again, with an injected clock, for up to 5 minutes; any other failure,
// a request already sent among them, is not.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";
import { DRAIN_MS } from "../listener/drain.mjs";
import { createProxy, defaultRelayUrl, listenerPolicy } from "../proxy/proxy.mjs";
import { LISTENER_WAIT_MS, notReached, untilReached } from "../proxy/wait.mjs";
import { listening, serve } from "./helpers.mjs";

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
  const { server, port } = await serve(t, (req, res) => {
    asked.push(req.url);
    res.end(JSON.stringify({ allowed: true, relay: true }));
  });
  await new Promise((resolve) => server.close(resolve));
  const clock = fakeClock();
  const sleep = clock.sleep;
  clock.sleep = async (ms) => {
    await sleep(ms);
    if (clock.sleeps.length === 2)
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  };
  const policy = listenerPolicy(`http://127.0.0.1:${port}/egress`, 5000, clock);
  assert.deepEqual(await policy("10.0.0.2", "api.github.com"), {
    allowed: true,
    private: false,
    cache: false,
    decrypt: false,
    relay: true,
  });
  assert.deepEqual(asked, ["/egress?ip=10.0.0.2&host=api.github.com"]);
  assert.equal(clock.sleeps.length, 2);

  // Gone for good: refused after 5 minutes, as a listener that says no.
  await new Promise((resolve) => server.close(resolve));
  const later = fakeClock();
  const gone = listenerPolicy(`http://127.0.0.1:${port}/egress`, 5000, later);
  assert.deepEqual(await gone("10.0.0.2", "api.github.com"), { allowed: false });
  assert.equal(later.t, LISTENER_WAIT_MS);
});

test("relayed requests go to the broker's port beside the policy's, without RELAY_URL", () => {
  assert.equal(defaultRelayUrl("http://listener:8082/egress"), "http://listener:8081/relay");
  // A POLICY_URL that names the broker's port, as before the policy had its own.
  assert.equal(defaultRelayUrl("http://listener:8081/egress"), "http://listener:8081/relay");
  assert.equal(
    defaultRelayUrl("http://broker.internal:9000/egress"),
    "http://broker.internal:9000/relay",
  );
});

test("a client that left stops the policy's wait: no question for nobody", async (t) => {
  const { server, port } = await serve(t, () => {});
  await new Promise((resolve) => server.close(resolve));
  const url = `http://127.0.0.1:${port}/egress`;
  const clock = fakeClock();
  const policy = listenerPolicy(url, 5000, clock);
  assert.deepEqual(await policy("10.0.0.2", "x.test", { gone: () => true }), { allowed: false });
  assert.equal(clock.t, 0);

  // Through the proxy: a CONNECT whose client hangs up while the listener is down.
  let sleeps = 0;
  const proxy = createProxy({
    policy: listenerPolicy(url, 5000, {
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
