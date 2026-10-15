import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";

async function serve(app) {
  const asked = [];
  const github = app && {
    repoToken: async (repo, extra) => {
      asked.push(extra ? `${repo} +${Object.keys(extra)}` : repo);
      return {
        token: `token-for-${repo}`,
        expiresAt: Date.parse("2026-10-14T13:00:00Z"),
      };
    },
  };
  const broker = createBroker({ app: () => github });
  const server = createServer((req, res) => broker.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = (path, secret) =>
    fetch(url + path, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
  return { broker, asked, get, close: () => server.close() };
}

test("a run's secret gets a token for its repo, until the run ends", async (t) => {
  const { broker, asked, get, close } = await serve(true);
  t.after(close);
  const a = broker.register("Org/A");
  const b = broker.register("org/b");
  const res = await get("/token", a);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), {
    token: "token-for-org/a",
    expires_at: "2026-10-14T13:00:00.000Z",
    repo: "org/a",
  });
  assert.equal((await (await get("/token", b)).json()).repo, "org/b");
  assert.deepEqual(asked, ["org/a", "org/b"]);
  broker.revoke(a);
  assert.equal((await get("/token", a)).status, 401);
  assert.equal(broker.size(), 1);
});

test("a run's extra permissions go with its tokens", async (t) => {
  const { broker, asked, get, close } = await serve(true);
  t.after(close);
  await get("/token", broker.register("org/a", { discussions: "write" }));
  assert.deepEqual(asked, ["org/a +discussions"]);
});

test("no secret, a wrong one or another path: nothing", async (t) => {
  const { broker, asked, get, close } = await serve(true);
  t.after(close);
  broker.register("org/a");
  assert.equal((await get("/token")).status, 401);
  assert.equal((await get("/token", "guess")).status, 401);
  assert.equal((await get("/other", "guess")).status, 404);
  assert.deepEqual(asked, []);
});

test("before the App is set up, no token", async (t) => {
  const { broker, get, close } = await serve(false);
  t.after(close);
  assert.equal((await get("/token", broker.register("org/a"))).status, 503);
});

test("only runs registered as work push; a restarted run's secret keeps its own", () => {
  const broker = createBroker({ app: () => null });
  assert.equal(broker.runOf(broker.register("org/a")).push, false);
  assert.equal(broker.runOf(broker.register("org/a", { pull_requests: "write" })).push, false);
  assert.equal(broker.runOf(broker.register("org/a", undefined, { push: "yes" })).push, false);
  assert.equal(broker.runOf(broker.register("org/a", undefined, { push: true })).push, true);
  const secret = broker.register("org/a", undefined, { push: true, secret: "kept" });
  assert.equal(secret, "kept");
  assert.equal(broker.runOf("kept").push, true);
});

test("a run's branches: none until allowed, and never for a run that can't push", () => {
  const broker = createBroker({ app: () => null });
  const work = broker.register("org/a", undefined, { push: true });
  assert.deepEqual(broker.runOf(work).branches, []);
  broker.allow(work, ["issue-1-*"]);
  assert.deepEqual(broker.runOf(work).branches, ["issue-1-*"]);
  const light = broker.register("org/a");
  broker.allow(light, ["issue-1-*"]);
  assert.deepEqual(broker.runOf(light).branches, []);
  // A finished run stays finished.
  broker.revoke(work);
  broker.allow(work, ["x"]);
  assert.equal(broker.runOf(work), undefined);
});
