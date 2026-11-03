// The runner's run events, as the listener reads them (listener/run-events.mjs): a sandbox's
// exit code on its run's record, a note in its log when it failed, each event acknowledged,
// for a run over already (its end said as its sandbox was removed) as for a live one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunEvents } from "../listener/run-events.mjs";

const noTimer = { setTimer: () => ({}), clearTimer: () => {} };

test("a sandbox's end: its exit code kept and saved, a failed one said in its log, every event acknowledged", async () => {
  const queue = [
    { id: "1", event: { type: "started", run: "r1" } },
    { id: "2", event: { type: "ended", run: "r1", exitCode: 137 } },
    { id: "3", event: { type: "ended", run: "r2", exitCode: 0 } },
    { id: "4", event: { type: "ended", run: "gone", exitCode: 1 } },
    // Said twice (the runner's look and its removal): the first stands.
    { id: "5", event: { type: "ended", run: "r1", exitCode: null } },
  ];
  const acked = [];
  const events = {
    read: async () => queue.filter((e) => !acked.includes(e.id)),
    ack: async (ids) => acked.push(...ids),
  };
  const written = { r1: [], r2: [] };
  const saved = [];
  const closed = [];
  const run = (id, finishedAt) => ({
    record: { key: `org/repo#${id}`, finishedAt },
    logFile: { write: (text) => written[id].push(JSON.parse(text)), close: () => closed.push(id) },
    save: () => saved.push(id),
  });
  // r1 over already (its summary written), r2 still live.
  const runs = { r1: run("r1", 5000), r2: run("r2", null) };
  const reader = createRunEvents({ events, runOf: (id) => runs[id] ?? null, ...noTimer });
  await reader.poll();
  assert.deepEqual(acked, ["1", "2", "3", "4", "5"]);
  assert.equal(runs.r1.record.exitCode, 137);
  assert.equal(runs.r2.record.exitCode, 0);
  assert.deepEqual(
    written.r1.map((e) => [e.event, e.message]),
    [["note", "Its sandbox exited with code 137"]],
  );
  assert.deepEqual(written.r2, []);
  // The note on a run over already: its log's last segment closed again after it.
  assert.deepEqual(closed, ["r1"]);
  assert.deepEqual(saved, ["r1", "r2"]);
  // Nothing new: nothing written, nothing acknowledged twice.
  await reader.poll();
  assert.equal(acked.length, 5);
  reader.stop();
});

// #618: the summary is in the store, a write away, before its event is acknowledged: a crash
// between the two loses no exit code.
test("an event is acknowledged once its run's summary is saved", async () => {
  const acked = [];
  const events = {
    read: async () => [{ id: "1", event: { type: "ended", run: "r1", exitCode: 137 } }],
    ack: async (ids) => acked.push(...ids),
  };
  let saved;
  const record = { key: "org/repo#1", finishedAt: 5000 };
  const run = {
    record,
    logFile: { write: () => {}, close: () => {} },
    save: () => new Promise((resolve) => (saved = resolve)),
  };
  const reader = createRunEvents({ events, runOf: () => run, ...noTimer });
  const polled = reader.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof saved, "function");
  assert.deepEqual(acked, []);
  saved();
  await polled;
  assert.deepEqual(acked, ["1"]);
});

test("a runner that doesn't answer: tried again at the next poll, nothing lost", async () => {
  let failing = true;
  const acked = [];
  const events = {
    read: async () => {
      if (failing) throw new Error("the runner service didn't answer");
      return [{ id: "9", event: { type: "ended", run: "r1", exitCode: 0 } }];
    },
    ack: async (ids) => acked.push(...ids),
  };
  const said = [];
  const reader = createRunEvents({
    events,
    runOf: () => null,
    log: (line) => said.push(line),
    ...noTimer,
  });
  await reader.poll();
  assert.match(said[0], /^Run events: the runner service didn't answer/);
  failing = false;
  await reader.poll();
  assert.deepEqual(acked, ["9"]);
});
