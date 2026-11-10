// The orchestrator alone at its start and stop, before it is up: a data volume it can't write, a
// stop while it loads its maps (orchestrator-harness.mjs has the services it calls).
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { createCallers } from "../broker/callers.mjs";
import { createBroker as createBrokerService } from "../broker/server.mjs";
import { openStore } from "../lib/store.mjs";
import { encode, replyParser } from "../lib/resp.mjs";
import {
  freshRedisPrefix,
  isRoot,
  needsModes,
  needsSignals,
  tempDir,
  testKey,
  until as waitUntil,
} from "./helpers.mjs";
import { start } from "./orchestrator-harness.mjs";

// Not root (#536): a data volume it can't write, one a root orchestrator of the release before
// wrote last, stops it at start, naming what and the chown. Only what comes before is started:
// the broker, for its service tokens, and the models service, which it asks before its settings.
test(
  "the orchestrator doesn't start on a data volume it can't write, and says the chown",
  { skip: (isRoot && "root writes anywhere") || needsModes },
  async (t) => {
    const dir = tempDir(t);
    const broker = createBrokerService({
      store: openStore("memory:"),
      key: testKey(),
      callers: createCallers({ networks: "orchestrator=127.0.0.0/8" }),
      keysDir: join(dir, "keys"),
    }).server;
    const models = createServer((req, res) =>
      res.end(
        JSON.stringify(
          req.url.startsWith("/credentials") ? { names: [] } : { salt: "s", values: [] },
        ),
      ),
    );
    for (const server of [broker, models]) {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => (server.closeAllConnections(), server.close()));
    }
    // Its store's state, root's again after the chown (the old orchestrator still saving it).
    const data = join(dir, "data");
    const state = join(data, "store", "state.json");
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, '{"keys":{"queue":{"value":["kept"]}}}');
    chmodSync(state, 0o400);
    const { child, output, exited } = start({
      DATA_DIR: data,
      ALLOWED_USERS: "alice",
      GRANTS_DIR: join(dir, "grants"),
      BROKER_SERVICE_URL: `http://127.0.0.1:${broker.address().port}`,
      MODELS_SERVICE_URL: `http://127.0.0.1:${models.address().port}`,
    });
    t.after(() => child.kill("SIGKILL"));
    const { code } = await exited;
    assert.equal(code, 1, output());
    assert.match(output(), /The orchestrator can't write .*state\.json \(EACCES\)/);
    assert.match(output(), /docker compose stop orchestrator.*--cap-add CHOWN/);
    // Nothing written: no folder of its own made, the state as it was.
    assert.ok(!existsSync(join(data, "logs")));
    assert.match(readFileSync(state, "utf8"), /kept/);
  },
);

// The orchestrator alone, on a real Redis (TEST_REDIS_URL, CI's) reached through a relay, stopped
// by SIGTERM before it is up, while what `refuses` fails is tried again (#692). `refuses(args)`:
// what a command is a try of, which the relay refuses (an unknown command in its place, whose
// error reply comes back where its own would have), or null. `env({ fail, dir, store })`: more
// settings, the services it calls among them, `fail(what)` marking a try of theirs refused. Once
// every one of `expect` failed, the SIGTERM. → its exit code, output, the tries made after the
// SIGTERM (`late`: none, the stop giving them up), and whether its lease was given back.
//
// Those tries' 5 s pauses are the orchestrator's own (lib/store-map.mjs, github/client.mjs,
// persist()), out of the test's reach: the SIGTERM goes 2 s after the last first failure, and
// the lease's release is held until 5.8 s after it, past the next try of each, had it gone on,
// and before the release's own 5 s timeout (lib/resp.mjs) 1.2 s later.
async function stoppedEarly(t, { refuses, expect, env = () => ({}) }) {
  const dir = tempDir(t);
  const broker = createBrokerService({
    store: openStore("memory:"),
    key: testKey(),
    callers: createCallers({ networks: "orchestrator=127.0.0.0/8" }),
    keysDir: join(dir, "keys"),
  }).server;
  const models = createServer((req, res) =>
    res.end(
      JSON.stringify(
        req.url.startsWith("/credentials") ? { names: [] } : { salt: "s", values: [] },
      ),
    ),
  );
  const failed = new Map();
  let signalled = false;
  const late = [];
  const fail = (what) => {
    if (!failed.has(what)) failed.set(what, Date.now());
    if (signalled) late.push(what);
  };
  const lastFailure = () => Math.max(...failed.values());
  const upstream = new URL(process.env.TEST_REDIS_URL);
  const relay = createNetServer((client) => {
    const redis = connect(Number(upstream.port || 6379), upstream.hostname);
    client.on("error", () => redis.destroy());
    redis.on("error", () => client.destroy());
    client.on("close", () => redis.destroy());
    redis.pipe(client);
    // In order: a held command holds back the ones after it, as a slow Redis would.
    let sent = Promise.resolve();
    client.on(
      "data",
      replyParser((args) => {
        const text = args.map(String);
        const what = refuses(text);
        if (what) fail(what);
        const held = signalled && text.some((arg) => arg.endsWith(":l:orchestrator"));
        const wait = held ? lastFailure() + 5800 - Date.now() : 0;
        sent = sent
          .then(() => wait > 0 && new Promise((resolve) => setTimeout(resolve, wait)))
          .then(() => redis.write(encode(what ? ["DECKHAND-STORE-AWAY"] : args)));
      }),
    );
  });
  for (const server of [broker, models, relay]) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => (server.closeAllConnections?.(), server.close()));
  }
  const direct = new URL(process.env.TEST_REDIS_URL);
  direct.searchParams.set("prefix", freshRedisPrefix(t, process.env.TEST_REDIS_URL));
  const relayed = new URL(direct);
  relayed.host = `127.0.0.1:${relay.address().port}`;
  const store = openStore(direct.href);
  t.after(() => store.close());
  const data = join(dir, "data");
  mkdirSync(data);
  const { child, output } = start({
    DATA_DIR: data,
    STORE_URL: relayed.href,
    SERVICES_PORT: "0",
    ALLOWED_USERS: "alice",
    GRANTS_DIR: join(dir, "grants"),
    BROKER_SERVICE_URL: `http://127.0.0.1:${broker.address().port}`,
    MODELS_SERVICE_URL: `http://127.0.0.1:${models.address().port}`,
    ...(await env({ fail, dir: data, store })),
  });
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.on("close", resolve));
  await waitUntil(() => expect.every((what) => failed.has(what)) || child.exitCode !== null, {
    ms: 30_000,
    what: expect.join(", "),
  });
  assert.equal(child.exitCode, null, output());
  await new Promise((resolve) => setTimeout(resolve, lastFailure() + 2000 - Date.now()));
  signalled = true;
  child.kill("SIGTERM");
  const code = await exited;
  // Given back: the next copy takes it at once, rather than once it expires.
  const lease = await store.acquire("orchestrator", "test", { ttlMs: 1000 });
  return { code, output: output(), late, leaseFree: !!lease };
}

const stopsEarly = {
  skip: (!process.env.TEST_REDIS_URL && "no Redis: set TEST_REDIS_URL") || needsSignals,
};

// The maps' load refused (its first command, the stamp storeMap() writes before it reads a
// map's items): read again every 5 s until the stop, which stops at the maps it never got
// rather than read them.
test(
  "a stop during the maps' first load gives up the read, exits cleanly and gives the lease back",
  stopsEarly,
  async (t) => {
    const stopped = await stoppedEarly(t, {
      refuses: (args) =>
        args.some((arg) => arg.includes(":k:store-maps/")) ? "the maps' read" : null,
      expect: ["the maps' read"],
    });
    assert.equal(stopped.code, 0, stopped.output);
    assert.doesNotMatch(stopped.output, /TypeError/);
    assert.deepEqual(stopped.late, []);
    assert.ok(stopped.leaseFree, stopped.output);
  },
);

// Past the maps, before it is up (edge, which it asks about the App, doesn't answer): a title's
// write (seeded from a run's summary; the maps' read, a SCAN of `titles/*`, goes through) and the
// operator's credentials' fingerprints, sent to the github service, tried again (a 500: a 503,
// the service's client asks again on its own, lib/service-client.mjs). The stop gives both up: a
// map's write carries no epoch, and would land over what the next copy wrote.
test(
  "a stop before the orchestrator is up gives up the maps' writes and the github service's calls",
  stopsEarly,
  async (t) => {
    const stopped = await stoppedEarly(t, {
      refuses: (args) => (args.some((arg) => /:k:titles\/[^*]/.test(arg)) ? "a title" : null),
      expect: ["a title", "the fingerprints"],
      env: async ({ fail, store }) => {
        await store.set("summaries/org-repo-5-1", {
          id: "org-repo-5-1",
          key: "org/repo#5",
          repo: "org/repo",
          title: "Five",
          startedAt: 1,
        });
        const github = createServer((req, res) => {
          if (req.method === "PUT" && req.url === "/fingerprints") fail("the fingerprints");
          res.writeHead(500).end("{}");
        });
        // Never answers: the orchestrator waits for it, 15 s at most, before it goes on.
        const edge = createServer(() => {});
        for (const server of [github, edge]) {
          await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
          t.after(() => (server.closeAllConnections(), server.close()));
        }
        return {
          GITHUB_SERVICE_URL: `http://127.0.0.1:${github.address().port}`,
          EDGE_URL: `http://127.0.0.1:${edge.address().port}`,
        };
      },
    });
    assert.equal(stopped.code, 0, stopped.output);
    assert.deepEqual(stopped.late, []);
    assert.ok(stopped.leaseFree, stopped.output);
  },
);
