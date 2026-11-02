import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { createSlots, readDelivery, sourceOf } from "../listener/deliveries.mjs";
import { serve } from "./helpers.mjs";

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
  // A place given back is taken again.
  b1();
  assert.equal(slots.size(), 3);
  assert.ok(take("d", "d1"));
  assert.deepEqual(dropped, []);
});

test("slots: full, a source holding fewer takes the biggest holder's oldest place, however young", () => {
  let clock = 0;
  const dropped = [];
  const slots = createSlots({ total: 4, share: 2, graceMs: 1000, now: () => clock });
  const take = (source, name) => slots.take(source, () => dropped.push(name));
  take("a", "a1");
  take("a", "a2");
  take("b", "b1");
  take("c", "c1");
  clock = 10;
  assert.ok(take("d", "d1"));
  assert.deepEqual(dropped, ["a1"]);
  // Now each holds one: a source already holding one doesn't get a young place.
  assert.equal(take("d", "d2"), null);
  assert.deepEqual(dropped, ["a1"]);
});

// The issue's churn: four sources each reopen a stalled body every 250 ms, so every place is
// always younger than the grace. A delivery from another address still gets in.
test("slots: sources churning stalled bodies don't keep every delivery out", () => {
  let clock = 0;
  const slots = createSlots({ total: 16, share: 4, graceMs: 1000, now: () => clock });
  let tries = 0;
  let refused = 0;
  for (; clock < 20000; clock += 50) {
    if (clock % 250 === 0) for (const source of "abcd") slots.take(source, () => {});
    if (clock > 2000) {
      tries++;
      const release = slots.take(`github-${clock}`, () => {});
      if (release) release();
      else refused++;
    }
  }
  assert.ok(tries > 300);
  assert.equal(refused, 0);
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
  // The ones left are young again, and "d" is refused while it holds as many as the most
  // ("a", with two, gives its oldest up).
  assert.ok(take("d", "d1"));
  assert.deepEqual(dropped, ["a1", "b1", "a2"]);
  assert.equal(take("d", "d2"), null);
});

// A server reading each request with readDelivery; `results` gets what each one came to.
async function serveReads(t, options) {
  const results = [];
  const { port } = await serve(t, (req, res) => {
    readDelivery(req, options).then(
      (body) => (results.push(body.toString()), res.end("ok")),
      (error) => results.push(error.message),
    );
  });
  const send = () => {
    const req = request({ port, method: "POST" });
    req.on("error", () => {});
    return req;
  };
  return { results, send };
}

const until = async (check) => {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 10));
};

test("readDelivery: a body, or a stalled one dropped after the idle timeout", async (t) => {
  const { results, send } = await serveReads(t, { limit: 100, idleMs: 1000, totalMs: 10_000 });
  const whole = send();
  whole.end("{}");
  await until(() => results.length === 1);
  assert.deepEqual(results, ["{}"]);
  // Chunks closer than the idle timeout keep it going; then nothing comes. Far closer: with
  // 60 ms of 100, a runner pausing the process 40 ms read the second chunk too late.
  const slow = send();
  slow.write("{");
  await new Promise((resolve) => setTimeout(resolve, 300));
  slow.write('"a"');
  await new Promise((resolve) => setTimeout(resolve, 300));
  slow.write("}");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(results.length, 1);
  await until(() => results.length === 2);
  assert.equal(results[1], "no data for 1000 ms");
});

test("readDelivery: dropped past its total time, however steady, or past its size", async (t) => {
  // A chunk every 30 ms, and an idle timeout longer than the total: however late a runner's
  // timers fire, the total ends it first.
  const steady = await serveReads(t, { limit: 100, idleMs: 1000, totalMs: 400 });
  const trickle = steady.send();
  const timer = setInterval(() => trickle.write(" "), 30);
  t.after(() => clearInterval(timer));
  await until(() => steady.results.length === 1);
  clearInterval(timer);
  assert.deepEqual(steady.results, ["body not received in 400 ms"]);
  const small = await serveReads(t, { limit: 10, idleMs: 100, totalMs: 5000 });
  small.send().end("x".repeat(11));
  await until(() => small.results.length === 1);
  assert.deepEqual(small.results, ["body over 10 bytes"]);
});
