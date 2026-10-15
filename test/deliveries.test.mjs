import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { createSlots, readDelivery, sourceOf } from "../listener/deliveries.mjs";

test("sourceOf: IPv4 as is, IPv6 by its /64", () => {
  assert.equal(sourceOf("203.0.113.9"), "203.0.113.9");
  assert.equal(sourceOf("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(sourceOf("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(sourceOf("2001:DB8:0:12:abcd::7"), "2001:db8:0:12::/64");
  assert.equal(sourceOf("2001:db8:0:12:abcd::7"), sourceOf("2001:db8:0:12::9"));
  assert.notEqual(sourceOf("2001:db8:0:12::9"), sourceOf("2001:db8:0:13::9"));
});

test("slots: a source holds its share, the rest stay for the others", () => {
  let clock = 0;
  const dropped = [];
  const slots = createSlots({ total: 4, share: 2, graceMs: 1000, now: () => clock });
  const take = (source, name) => slots.take(source, () => dropped.push(name));
  assert.ok(take("a", "a1"));
  assert.ok(take("a", "a2"));
  // Its share taken, and its readers still young: refused, without dropping anyone.
  assert.equal(take("a", "a3"), null);
  assert.deepEqual(dropped, []);
  // Another source still gets in: a signed delivery while one client holds its share.
  const b1 = take("b", "b1");
  assert.ok(b1);
  assert.ok(take("c", "c1"));
  // Full, all young: refused.
  assert.equal(take("d", "d1"), null);
  // A place given back is taken again.
  b1();
  assert.equal(slots.size(), 3);
  assert.ok(take("d", "d1"));
  assert.deepEqual(dropped, []);
});

test("slots: past the grace, a newcomer takes the oldest reader's place, its own source's first", () => {
  let clock = 0;
  const dropped = [];
  const slots = createSlots({ total: 3, share: 2, graceMs: 1000, now: () => clock });
  const take = (source, name) => slots.take(source, () => dropped.push(name));
  take("a", "a1");
  clock = 100;
  take("b", "b1");
  clock = 1000;
  take("a", "a2");
  clock = 1500;
  // Behind a reverse proxy every delivery has its address: a new one replaces a stalled one.
  assert.ok(take("a", "a3"));
  assert.deepEqual(dropped, ["a1"]);
  // Full: the oldest of all, past the grace, makes room.
  assert.ok(take("c", "c1"));
  assert.deepEqual(dropped, ["a1", "b1"]);
  assert.equal(slots.size(), 3);
  // The ones left are young again: refused.
  assert.equal(take("d", "d1"), null);
});

// A server reading each request with readDelivery; `results` gets what each one came to.
async function serve(t, options) {
  const results = [];
  const server = createServer((req, res) => {
    readDelivery(req, options).then(
      (body) => (results.push(body.toString()), res.end("ok")),
      (error) => results.push(error.message),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const send = () => {
    const req = request({ port: server.address().port, method: "POST" });
    req.on("error", () => {});
    return req;
  };
  return { results, send };
}

const until = async (check) => {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 10));
};

test("readDelivery: a body, or a stalled one dropped after the idle timeout", async (t) => {
  const { results, send } = await serve(t, { limit: 100, idleMs: 100, totalMs: 5000 });
  const whole = send();
  whole.end("{}");
  await until(() => results.length === 1);
  assert.deepEqual(results, ["{}"]);
  // Chunks closer than the idle timeout keep it going; then nothing comes.
  const slow = send();
  slow.write("{");
  await new Promise((resolve) => setTimeout(resolve, 60));
  slow.write('"a"');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(results.length, 1);
  await until(() => results.length === 2);
  assert.equal(results[1], "no data for 100 ms");
});

test("readDelivery: dropped past its total time, however steady, or past its size", async (t) => {
  const steady = await serve(t, { limit: 100, idleMs: 100, totalMs: 200 });
  const trickle = steady.send();
  const timer = setInterval(() => trickle.write(" "), 30);
  t.after(() => clearInterval(timer));
  await until(() => steady.results.length === 1);
  clearInterval(timer);
  assert.deepEqual(steady.results, ["body not received in 200 ms"]);
  const small = await serve(t, { limit: 10, idleMs: 100, totalMs: 5000 });
  small.send().end("x".repeat(11));
  await until(() => small.results.length === 1);
  assert.deepEqual(small.results, ["body over 10 bytes"]);
});
