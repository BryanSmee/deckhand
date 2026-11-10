// The orchestrator end to end, its restarts and handovers (orchestrator-harness.mjs has the
// harness): runs going on through them, its data volume and store, the maps moved to it.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openStore } from "../lib/store.mjs";
import { fileName } from "../lib/store-file.mjs";
import { freshRedisPrefix, localStatus } from "./helpers.mjs";
import {
  comment,
  dashboardApi,
  exists,
  followUp,
  holding,
  listen,
  liveStates,
  onlyLog,
  options,
  pastRun,
  prompts,
  replies,
  settled,
  storedMap,
  summary,
  until,
} from "./orchestrator-harness.mjs";

describe("listener", options, () => {
  // Temporary files of state writes, in the data volume.
  const leftovers = (dir) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

  test("on SIGTERM the orchestrator holds none of the sandboxes' calls: one in flight goes on as it exits", async (t) => {
    const ctx = await holding(t);
    const { dir, github, proxyPort, policyPort, listener } = ctx;
    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    // A sandbox's call the GitHub gateway relays, left unanswered (an agent's stream, a push).
    const slow = (r) => r.method === "GET" && r.path === "/repos/org/repo/commits/held";
    const release = github.hold(slow);
    t.after(release);
    const inFlight = fetch(
      `http://127.0.0.1:${proxyPort}/relay/127.0.0.1/repos/org/repo/commits/held`,
      { headers: { authorization: `token ${secret}` } },
    );
    await github.waitFor(slow);

    // The egress policy answers on its own port: the sandboxes' connections go on.
    const asked = await fetch(`http://127.0.0.1:${policyPort}/egress?ip=10.9.0.5&host=github.com`);
    assert.equal((await asked.json()).allowed, true);
    // The orchestrator exits without waiting for the call, which is the github service's.
    const exited = new Promise((resolve) => listener.child.on("exit", resolve));
    listener.child.kill("SIGTERM");
    assert.equal(await exited, 0);
    release();
    const answer = await inFlight;
    assert.equal(answer.status, 200);
    await answer.text();
  });

  test("a restart during a run: it goes on, a new comment reaches it, one reply", async (t) => {
    const ctx = await holding(t);
    const { dir, github, send, proxyPort } = ctx;
    const { code, output } = await ctx.restart();
    assert.equal(code, 0);
    assert.match(output, /Stopping: running sandboxes go on/);
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");

    // Its GitHub calls still go through, at the github service's gateway.
    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    const token = await fetch(`http://127.0.0.1:${proxyPort}/relay/127.0.0.1/repos/org/repo`, {
      headers: { authorization: `token ${secret}` },
    });
    assert.equal(token.status, 200);

    // A comment without a trigger line goes to the running session, through its inbox.
    await send(followUp(100, "Also cover the edge case"));
    const [run] = readdirSync(join(dir, "runs"));
    const inbox = join(dir, "runs", run, "inbox.jsonl");
    await until(() => exists(inbox)?.includes("Also cover the edge case"), "the delivery");
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
    assert.match(exists(join(dir, "delivered")), /Also cover the edge case/);
    // Both comments get their outcome.
    await settled(github, [99, 100]);
    assert.equal(replies(github).length, 1);
    assert.match(JSON.parse(replies(github)[0].body).body, /^Answered\./);
    // The sandbox, its inbox and the run's saved state are gone, once the run is torn down.
    await until(() => !readdirSync(join(dir, "containers")).length, "the sandbox's removal");
    assert.deepEqual(readdirSync(join(dir, "runs")), []);
    assert.deepEqual(liveStates(dir), []);
    // Its state was written whole each time (lib/files.mjs).
    assert.deepEqual(leftovers(dir), []);
  });

  test("a recreated proxy joins the running sandbox's network again", async (t) => {
    const ctx = await holding(t);
    const { dir } = ctx;
    const [net] = readdirSync(join(dir, "nets"));
    const joined = () =>
      readFileSync(join(dir, "nets", net), "utf8")
        .split("\n")
        .filter(Boolean);
    // Its own network: the sandbox and the proxy, nothing else.
    assert.equal(joined().length, 2);
    assert.ok(joined().includes("egress-1"));
    // Left by a run nobody knows about any more.
    writeFileSync(join(dir, "nets", "deckhand-gone-1"), "egress-1\n");
    // `docker compose up -d`: new containers, on none of the runs' networks.
    writeFileSync(join(dir, "nets", net), joined()[0] + "\n");
    // The runner's settings: it joins it.
    await ctx.restartRunner({ EGRESS_CONTAINER: "egress-2" });
    await ctx.restart();
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    assert.deepEqual(joined().slice(1), ["egress-2"]);
    const calls = readFileSync(join(dir, "docker-calls"), "utf8");
    assert.match(calls, new RegExp(`^network connect ${net} egress-2$`, "m"));
    assert.deepEqual(readdirSync(join(dir, "nets")), [net]);
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
    // The run's network goes with it.
    await until(() => !readdirSync(join(dir, "nets")).length, "the network's removal");
    assert.match(
      calls + readFileSync(join(dir, "docker-calls"), "utf8"),
      new RegExp(`^network rm ${net}$`, "m"),
    );
  });

  test("a comment queued for a running session is checked against the repo's users after a restart", async (t) => {
    const files = { ".deckhand.yaml": "users: [alice, bob]\n" };
    const ctx = await listen(t, files, (dir) => {
      writeFileSync(join(dir, "hold"), "");
      return {};
    });
    const { dir } = ctx;
    await ctx.send(comment("alice"));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 10, "the sandbox");
    // Bob's comment waits out a long pause for the running session, then the listener stops.
    await ctx.restart({ DEBOUNCE_MS: "60000" });
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    await ctx.send({
      ...followUp(100, "Also delete the tests"),
      comment: { id: 100, body: "Also delete the tests", user: { login: "bob", type: "User" } },
    });
    await ctx.github.waitFor((r) => r.path === "/repos/org/repo/issues/comments/100/reactions");
    // Meanwhile, the repo's users leave bob out.
    files[".deckhand.yaml"] = "users: [alice]\n";
    const { output } = await ctx.restart({ DEBOUNCE_MS: "0" });
    assert.match(output, /1 task\(s\) with queued comments left to the next copy/);
    await ctx.listener.until("a queued comment dropped: bob is no longer an allowed user");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [run] = readdirSync(join(dir, "runs"));
    assert.doesNotMatch(exists(join(dir, "runs", run, "inbox.jsonl")) ?? "", /delete the tests/);
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
  });

  // The orchestrator's handover (#506), with its two copies: issue 12's run held, a comment on
  // issue 13 queued behind it (one run at a time), the next copy waiting for the lease. `files`
  // and `extra(dir)`: what the fake GitHub serves, and more settings.
  async function handingOver(t, { lease = 8, files = {}, extra = () => ({}) } = {}) {
    // A lease far longer than a handover: taking it at once shows it was released.
    // GITHUB_URL: the dashboard's sign-in, through the fake GitHub.
    const ctx = await holding(
      t,
      "Deckhand",
      (dir, github) => ({
        MAX_PARALLEL: "1",
        LEASE_SECONDS: String(lease),
        GITHUB_URL: github.url,
        ...extra(dir),
      }),
      files,
    );
    const queued = comment("alice");
    queued.issue = { number: 13 };
    queued.comment = { ...queued.comment, id: 130 };
    await ctx.send(queued);
    for (let i = 0; ; i++) {
      if ((await localStatus(ctx.port, join(ctx.dir, "edge"))).queued === 1) break;
      if (i > 400) throw new Error("timed out waiting for the queued comment");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return ctx;
  }

  const posted = (github, number) =>
    github.requests.filter(
      (r) => r.method === "POST" && r.path === `/repos/org/repo/issues/${number}/comments`,
    );

  // Its epoch refused by every service it called: the github service, the runner, the broker.
  async function staleEverywhere(ctx, epoch) {
    const headers = (aud) => ({
      authorization: ctx.serviceToken("orchestrator", aud),
      "x-deckhand-epoch": String(epoch),
      "content-type": "application/json",
    });
    const github = await fetch(`${ctx.urls.github}/reactions`, {
      method: "PUT",
      headers: headers("github"),
      body: JSON.stringify({ repo: "org/repo", subject: "comment:1", content: "eyes" }),
    });
    assert.equal(github.status, 409, await github.text());
    const runner = await fetch(`${ctx.urls.runner}/sandboxes/deckhand-org-repo-12-x/kill`, {
      method: "POST",
      headers: headers("runner"),
      body: "{}",
    });
    assert.equal(runner.status, 409, await runner.text());
    const broker = await fetch(`${ctx.urls.broker}/runs/nothing`, {
      method: "DELETE",
      headers: headers("broker"),
    });
    assert.equal(broker.status, 409, await broker.text());
  }

  // A crash's lease is waited out, twice: 4 s rather than 8, still past a handover's time.
  for (const [signal, how, lease] of [
    ["SIGTERM", "on SIGTERM: the lease released, taken at once", 8],
    ["SIGKILL", "after a crash: the lease taken once it expired", 4],
  ]) {
    test(`a handover ${how}; a queued comment runs once, a run's end gets one reply, the old epoch is refused`, async (t) => {
      const ctx = await handingOver(t, { lease });
      const { dir, github } = ctx;
      // The next copy's metrics (lib/metrics.mjs): its lease not held while it waits, then held.
      const scrape = async (copy) => {
        await copy.until(/Metrics on :\d+\/metrics/);
        const port = /Metrics on :(\d+)\/metrics/.exec(copy.own())[1];
        return (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
      };
      const leaseHeld = async (copy) => {
        const text = await scrape(copy);
        // What only the acting copy knows (listener/metrics.mjs), the waiting one has no sample of.
        if (!copy.own().includes("lease taken")) {
          assert.doesNotMatch(text, /^deckhand_runs_running /m);
          assert.doesNotMatch(text, /^deckhand_runs_queued\{/m);
          assert.doesNotMatch(text, /^deckhand_auto_pickup_slots\{/m);
        }
        return /^deckhand_lease_held\{lease="orchestrator"\} (\d)$/m.exec(text)?.[1];
      };
      const { output, epoch, next, took } = await ctx.handOver({
        signal,
        // Claude answers issue 12 while the copies hand over.
        between: async () => writeFileSync(join(dir, "go"), ""),
        more: { METRICS_PORT: "0" },
        waiting: async (copy) => assert.equal(await leaseHeld(copy), "0"),
      });
      assert.equal(await leaseHeld(ctx.listener), "1");
      if (signal === "SIGTERM") {
        assert.match(output, /orchestrator: lease released/);
        // Not a lease's life (8 s here, 15 by default): the waiting copy took it at once.
        assert.ok(took < 3000, `${took} ms`);
      } else {
        // Its lease left to expire: at least what was left of it (2.7 s), its last renewal 4/3 s
        // ago at most.
        assert.ok(took > 2000, `${took} ms`);
      }
      assert.ok(next > epoch, `${next} after ${epoch}`);
      // Issue 12's run ended across the handover: one reply. Then 13's, from the queue: one run.
      await settled(github, [99, 130]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(posted(github, 12).length, 1);
      assert.equal(posted(github, 13).length, 1);
      const runs = ctx.listener.output().match(/org\/repo#13: done/g) ?? [];
      assert.equal(runs.length, 1, ctx.listener.output());
      // Its metrics (listener/metrics.mjs): 13's run started here, 12's and 13's ended here; its
      // calls to the github service counted.
      const text = await scrape(ctx.listener);
      const sum = (name) =>
        [...text.matchAll(new RegExp(`^${name}\\{[^}]*\\} (\\d+)$`, "gm"))].reduce(
          (n, m) => n + Number(m[1]),
          0,
        );
      assert.equal(sum("deckhand_runs_started_total"), 1, text);
      assert.equal(sum("deckhand_runs_finished_total"), 2, text);
      assert.match(text, /^deckhand_runs_finished_total\{mode="work",outcome="ok"\} 2$/m);
      assert.match(text, /^deckhand_runs_running 0$/m);
      assert.ok(sum("deckhand_service_calls_total") > 0, text);
      assert.match(text, /^deckhand_service_calls_total\{callee="github",status="200"\} \d+$/m);
      // The copy that stopped could no longer act, had it gone on.
      await staleEverywhere(ctx, epoch);
      // The dashboard's history, from the store alone (#618): the same after another handover.
      const api = await dashboardApi(ctx.port);
      const history = async () =>
        (await api("/api/state")).tasks.flatMap((task) => task.runs.map((r) => [r.id, r.status]));
      const before = await history();
      assert.equal(before.length, 2);
      await ctx.handOver({ signal });
      assert.deepEqual(await history(), before);
      // Nothing written beside the store (#619).
      assert.equal(existsSync(join(dir, "logs")), false);
    });
  }

  // The orchestrator keeps nothing but its store (#619): a data folder it can't write but the
  // store's folder (for root, which writes anywhere, the folder as it is after), a run through a
  // handover, its reply once, and nothing beside the store.
  test("nothing written but the store: a data folder it can't write but its store's, a run through a handover", async (t) => {
    let data;
    const ctx = await holding(t, undefined, (dir) => {
      data = join(dir, "orchestrator-data");
      mkdirSync(join(data, "store"), { recursive: true });
      chmodSync(data, 0o555);
      // Writable again for the temp dir's removal.
      t.after(() => chmodSync(data, 0o755));
      return { ORCHESTRATOR_DATA_DIR: data };
    });
    const { github } = ctx;
    await ctx.handOver();
    writeFileSync(join(ctx.dir, "go"), "");
    await ctx.listener.until("done (ok)");
    await settled(github, [99]);
    assert.equal(replies(github).length, 1);
    assert.match(JSON.parse(replies(github)[0].body).body, /^All done\./);
    // Its summary in the store, the dashboard's history.
    const keys = join(data, "store", "keys", "summaries%2F");
    const summaries = readdirSync(keys);
    assert.equal(summaries.length, 1);
    assert.equal(JSON.parse(readFileSync(join(keys, summaries[0]), "utf8")).value.status, "ok");
    assert.deepEqual(readdirSync(data), ["store"]);
    assert.doesNotMatch(ctx.listener.output(), /no longer is read/);
  });

  // #613's acceptance: the orchestrator on Redis, no volume. Each copy on a "node" of its own:
  // the first with an empty data folder it can't write, the next with none at all. The first
  // crashes (SIGKILL: nothing saved on the way out) with issue 12's run live, 13's comment
  // queued and 14's waiting for #77; the next takes over all of them, and the dashboard's
  // history, from Redis alone, and neither writes a file (for root, which writes anywhere, the
  // folders as they are after).
  test(
    "on Redis with no volume (#613): a copy on another node takes over a live run, the queue, a wait and the history",
    { skip: !process.env.TEST_REDIS_URL && "no Redis: set TEST_REDIS_URL" },
    async (t) => {
      const url = new URL(process.env.TEST_REDIS_URL);
      url.searchParams.set("prefix", freshRedisPrefix(t, url.href));
      let nodeA;
      let nodeB;
      const files = { "issue:77": JSON.stringify({ state: "open" }) };
      const ctx = await handingOver(t, {
        lease: 4,
        files,
        extra: (dir) => {
          nodeA = join(dir, "node-a");
          nodeB = join(dir, "node-b");
          mkdirSync(nodeA);
          chmodSync(nodeA, 0o555);
          t.after(() => chmodSync(nodeA, 0o755));
          return { ORCHESTRATOR_DATA_DIR: nodeA, ORCHESTRATOR_STORE_URL: url.href };
        },
      });
      const { dir, github, send } = ctx;
      const after = comment("alice", "Deckhand /after #77\nThen this.");
      after.issue = { number: 14 };
      after.comment = { ...after.comment, id: 140 };
      await send(after);
      await until(() => posted(github, 14).length === 1, "the waiting reply");
      const store = openStore(url.href);
      t.after(() => store.close());
      await until(
        async () => (await store.get("waits/org/repo#14"))?.blockers?.[0] === 77,
        "the wait",
      );
      assert.ok((await store.keys("runs/")).keys.length, "the live run's state");

      await ctx.handOver({
        signal: "SIGKILL",
        between: async () => writeFileSync(join(dir, "go"), ""),
        more: { ORCHESTRATOR_DATA_DIR: nodeB },
      });
      // 12's run ended across the handover, 13's run from the queue: one reply each.
      await settled(github, [99, 130]);
      assert.equal(posted(github, 12).length, 1);
      assert.equal(posted(github, 13).length, 1);
      // #77 done: the wait starts 14's comment, once.
      files["issue:77"] = JSON.stringify({ state: "closed", state_reason: "completed" });
      await send(
        {
          action: "closed",
          installation: { id: 7 },
          repository: { full_name: "org/repo", default_branch: "trunk" },
          issue: { number: 77, state: "closed", state_reason: "completed" },
          sender: { login: "alice" },
        },
        "issues",
      );
      await settled(github, [140]);
      const starting = posted(github, 14).filter((r) => /#77 is done: starting/.test(r.body));
      assert.equal(starting.length, 1);
      assert.equal(ctx.listener.output().match(/org\/repo#14: done/g)?.length, 1);
      assert.equal(await store.get("waits/org/repo#14"), null);

      // The dashboard's history, from Redis: the three runs, the same after another handover.
      const api = await dashboardApi(ctx.port);
      const history = async () =>
        (await api("/api/state")).tasks
          .flatMap((task) => task.runs.map((r) => [r.id, r.status]))
          .sort();
      const before = await history();
      assert.equal(before.length, 3, JSON.stringify(before));
      await ctx.handOver({ more: { ORCHESTRATOR_DATA_DIR: nodeA } });
      assert.deepEqual(await history(), before);
      assert.equal((await store.keys("summaries/")).keys.length, 3);
      // No file written: node A's folder empty, node B's never made.
      assert.deepEqual(readdirSync(nodeA), []);
      assert.equal(existsSync(nodeB), false);
      assert.equal(existsSync(join(dir, "store")), false);
    },
  );

  // A run's end whose summary the store refuses (#619), its copy stopping meanwhile: the run left
  // as it is, its sandbox and its state, the next copy ends it once: its summary saved, its
  // sandbox and state gone, its reactions set, and no second reply.
  test("a run's summary the store refuses as its copy stops: the next copy ends the run once", async (t) => {
    const ctx = await holding(t);
    const { dir, github } = ctx;
    // A folder where the store writes the run's summary (its items a file each, keys/): the
    // write refused, whoever runs the test.
    const [{ id }] = liveStates(dir);
    const blocked = join(dir, "store", "keys", "summaries%2F", fileName(`summaries/${id}`));
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until(/saving the summary of /);
    assert.equal(replies(github).length, 1);
    // The next copy started only once the folder is gone: one waiting for the lease takes it as
    // the stopping copy gives it up, and would read the summary's key while the folder is there.
    const old = ctx.listener.child;
    const exited = new Promise((resolve) => old.once("exit", resolve));
    old.kill("SIGTERM");
    await exited;
    rmSync(blocked, { recursive: true });
    const { output } = await ctx.restart();
    assert.match(
      output,
      /its summary not saved as this copy stops: the run stays for the next one/,
    );
    await ctx.listener.until("done (ok)");
    await settled(github, [99]);
    await until(() => !liveStates(dir).length, "the run's state to go");
    assert.equal(summary(dir)?.status, "ok");
    assert.deepEqual(readdirSync(join(dir, "containers")), []);
    assert.equal(replies(github).length, 1);
    const rockets = github.requests.filter(
      (r) => r.path === "/repos/org/repo/issues/comments/99/reactions" && /rocket/.test(r.body),
    );
    assert.equal(rockets.length, 1);
  });

  // What a release before left in the data volume (#619): moved, its emptied folders removed, and
  // what nothing reads any more named for the operator, never the store nor what still moves.
  test("a data volume of a release before: moved, emptied, what is left named", async (t) => {
    let data;
    const { listener } = await listen(t, {}, (dir) => {
      data = join(dir, "orchestrator-data");
      mkdirSync(join(data, "logs"), { recursive: true });
      mkdirSync(join(data, "shots"));
      writeFileSync(join(data, "titles.json"), JSON.stringify({ "org/repo#5": "Five" }));
      writeFileSync(join(data, "run-token.key"), "old");
      // A run log from before the runner service, whose move is gone, beside a summary moved.
      writeFileSync(join(data, "logs", "org-repo-1-1000.log"), "{}\n");
      writeFileSync(
        join(data, "logs", "org-repo-2-1000.json"),
        JSON.stringify({ id: "org-repo-2-1000", key: "org/repo#2", startedAt: Date.now() }),
      );
      return { ORCHESTRATOR_DATA_DIR: data };
    });
    const line = await listener.until(/holds .*, which no longer is read/);
    assert.match(
      line,
      /holds run-token\.key, logs\/org-repo-1-1000\.log, which no longer is read: remove them \(docs\/guides\/upgrade-notes\.md#upgrading-the-orchestrator-without-a-volume-619\)/,
    );
    // shots/ emptied, removed; logs/ kept for what is left in it.
    assert.deepEqual(readdirSync(data).sort(), ["logs", "run-token.key", "store"]);
    assert.deepEqual(readdirSync(join(data, "logs")), ["org-repo-1-1000.log"]);
  });

  test("a listener killed mid-run: Claude answers meanwhile, the next one replies once", async (t) => {
    const ctx = await holding(t);
    const { dir, github } = ctx;
    // Claude answers while no listener is there: the sandbox waits for its inbox to close.
    const killed = ctx.listener.child;
    killed.kill("SIGKILL");
    await new Promise((resolve) => killed.on("exit", resolve));
    writeFileSync(join(dir, "go"), "");
    const [name] = readdirSync(join(dir, "containers"));
    const out = join(dir, "containers", name, "out");
    await until(() => exists(out)?.includes('"type":"result"'), "Claude's answer");
    await ctx.restart();
    await ctx.listener.until("done (ok)");
    await settled(github, [99]);
    assert.equal(replies(github).length, 1);
    assert.match(JSON.parse(replies(github)[0].body).body, /^All done\./);
    // Its log on the dashboard holds Claude's answer once.
    const results = (await onlyLog(dir)).match(/"type":"result"/g);
    assert.equal(results.length, 1);
  });

  test(
    "a listener killed during a comment's pause: the next one runs it once, at its deadline",
    { timeout: 120_000 },
    async (t) => {
      // Long enough for a slow engine to kill the first listener within it.
      const PAUSE_MS = 8000;
      const ctx = await listen(t, {}, { DEBOUNCE_MS: String(PAUSE_MS) });
      const sent = Date.now();
      await ctx.send(comment("alice"));
      await ctx.listener.until("queued (work");
      await ctx.github.waitFor((r) => r.path === "/repos/org/repo/issues/comments/99/reactions");
      // Its 👀's id saved once GitHub answered (a listener killed before can't know it).
      const state = join(ctx.dir, "store", "state.json");
      await until(() => /"eyes": ?1\b/.test(exists(state) ?? ""), "the 👀 in the saved queue");
      // No SIGTERM: nothing is saved on the way out. The next one's own pause is a minute, and
      // the comment's deadline still holds.
      await ctx.restart({ signal: "SIGKILL", DEBOUNCE_MS: "60000" });
      const line = await ctx.listener.until(
        /1 comment\(s\) queued before the restart, due in \d+ ms/,
      );
      assert.ok(Number(line.match(/due in (\d+) ms/)[1]) <= PAUSE_MS);
      await ctx.listener.until("done (ok)");
      assert.ok(Date.now() - sent >= PAUSE_MS);
      // Not after a pause of the next listener's own (a minute).
      assert.ok(Date.now() - sent < 30_000);
      assert.equal(prompts(ctx.dir).length, 1);
      assert.equal(replies(ctx.github).length, 1);
      // Its 👀 from before the restart is replaced by the outcome.
      await ctx.github.waitFor(
        (r) => r.method === "DELETE" && r.path === "/repos/org/repo/issues/comments/99/reactions/1",
      );
      assert.deepEqual(leftovers(ctx.dir), []);
    },
  );

  test("a comment queued before a restart doesn't run once its author left ALLOWED_USERS", async (t) => {
    const ctx = await listen(t, {}, { DEBOUNCE_MS: "60000" });
    await ctx.send(comment("alice"));
    await ctx.listener.until("queued (work");
    await ctx.github.waitFor((r) => r.path === "/repos/org/repo/issues/comments/99/reactions");
    // Stopped first, to see what it leaves: the queue, the owner's only.
    const { child } = ctx.listener;
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    assert.equal(statSync(join(ctx.dir, "store", "state.json")).mode & 0o777, 0o600);
    await ctx.restart({ DEBOUNCE_MS: "0", ALLOWED_USERS: "bob" });
    await ctx.listener.until("dropped: alice is no longer an allowed user");
    // Its 👀 goes, and nothing runs.
    await ctx.github.waitFor(
      (r) => r.method === "DELETE" && r.path === "/repos/org/repo/issues/comments/99/reactions/1",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(exists(join(ctx.dir, "run-args")), null);
    assert.equal(replies(ctx.github).length, 0);
  });

  test("a comment whose author leaves the repo's users while it waits doesn't run", async (t) => {
    const files = { ".deckhand.yaml": "users: [alice, bob]\n" };
    const ctx = await listen(t, files, { DEBOUNCE_MS: "300" });
    await ctx.send(comment("alice"));
    await ctx.listener.until("queued (work");
    files[".deckhand.yaml"] = "users: [bob]\n";
    await ctx.listener.until("a queued comment dropped: alice is no longer an allowed user");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(exists(join(ctx.dir, "run-args")), null);
    // The queue goes on: bob's comment runs.
    await ctx.send({
      ...comment("bob"),
      comment: { id: 100, body: "Deckhand", user: { login: "bob", type: "User" } },
    });
    await ctx.listener.until("done (ok)");
  });

  test("a comment on a pull request saying Closes #3 joins #3 only from a branch of the repo", async (t) => {
    const { github, send, listener } = await listen(t);
    const onPull = (number, id) => {
      const payload = comment("alice");
      // Opened by someone else than the App: its head is looked up.
      payload.issue = {
        number,
        body: "Closes #3",
        pull_request: {},
        user: { login: "github-actions[bot]", type: "Bot" },
        author_association: "NONE",
      };
      payload.comment = { ...payload.comment, id };
      return payload;
    };
    await send(onPull(42, 101));
    await listener.until("org/repo#3: queued");
    await listener.until("done (ok)");
    await send(onPull(43, 102));
    await listener.until("org/repo#pr-43: queued");
    assert.match(listener.output(), /org\/repo#pr-43: says it closes #3, not linked/);
    await listener.until(/org\/repo#pr-43: done \(ok\)/);
    assert.ok(github.requests.some((r) => r.path === "/repos/org/repo/pulls/43"));
  });

  test("a restart after Claude answered once: nothing is read twice", async (t) => {
    const ctx = await holding(t);
    const { dir, github, send } = ctx;
    writeFileSync(join(dir, "hold-answer"), "");
    await send(followUp(100, "Also cover the edge case"));
    const [run] = readdirSync(join(dir, "runs"));
    const inbox = join(dir, "runs", run, "inbox.jsonl");
    await until(() => exists(inbox)?.includes("Also cover the edge case"), "the delivery");
    writeFileSync(join(dir, "go"), "");
    // Claude answered the prompt and reads the comment: the listener restarts meanwhile.
    await until(() => exists(join(dir, "delivered")), "Claude reading the comment");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await ctx.restart();
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    writeFileSync(join(dir, "answer"), "");
    await ctx.listener.until("done (ok)");
    await settled(github, [99, 100]);
    assert.equal(replies(github).length, 1);
    assert.match(JSON.parse(replies(github)[0].body).body, /^Answered\./);
    // Both answers once each in the run's log, and the duration of both in the footer.
    const text = await onlyLog(dir);
    assert.equal(text.match(/"type":"result"/g).length, 2);
    assert.equal(text.match(/pull\/13/g).length, 1);
    // Its phases: setup right after its first line, then each once, the restart in between.
    const lines = text.trim().split("\n");
    assert.match(lines[1], /"event":"phase","at":\d+,"phase":"setup"/);
    const phases = lines.filter((l) => l.includes('"event":"phase"'));
    assert.deepEqual(
      phases.map((l) => JSON.parse(l).phase),
      ["setup", "work", "wrap-up"],
    );
    assert.match(JSON.parse(replies(github)[0].body).body, / · 1\.1 min/);
  });

  test("at start: an issue closed, or unlabelled, while no listener heard it sets its run's questions aside", async (t) => {
    const asked =
      "<!-- needs-input -->\n## Needs your input\n\n1. **Name**: which one?\n   - [ ] A";
    const files = {};
    const { dir, port, listener, send } = await listen(t, files, (dir, github) => {
      for (const n of [5, 8, 11, 14]) {
        pastRun(dir, `org-repo-${n}-1000`, [
          {
            type: "listener",
            key: `org/repo#${n}`,
            repo: "org/repo",
            taskMode: "work",
            startedAt: 1000,
          },
          { type: "result", result: asked, duration_ms: 6000 },
        ]);
      }
      // Both known closed. #5 closed after its run asked; #8 before (a comment on a closed issue
      // started its run), so its questions still wait.
      writeFileSync(
        join(dir, "closed.json"),
        JSON.stringify({ "org/repo#5": "completed", "org/repo#8": "completed" }),
      );
      const closedAt = (ms) => ({
        state: "closed",
        state_reason: "completed",
        closed_at: new Date(ms).toISOString(),
      });
      files["issue:5"] = JSON.stringify({
        number: 5,
        title: "Five",
        ...closedAt(Date.now() + 60_000),
      });
      files["issue:8"] = JSON.stringify({
        number: 8,
        title: "Eight",
        ...closedAt(Date.now() - 3_600_000),
      });
      // #11 was labelled when the listener last heard of it; the label's listing no longer has
      // it (inputs.mjs sync()).
      // #14 too, but GitHub still has it labelled: the listing missed it. #16 as well, with
      // questions in its body and no run.
      writeFileSync(
        join(dir, "inputs.json"),
        JSON.stringify({
          "org/repo#11": { since: 1000, questions: null, ignoredTicks: true },
          "org/repo#14": { since: 1000, questions: null },
          "org/repo#16": { since: 2000, questions: null },
        }),
      );
      const after = new Date(Date.now() + 60_000).toISOString();
      files["issue:11"] = JSON.stringify({
        number: 11,
        state: "open",
        labels: [],
        updated_at: after,
      });
      files["issue:14"] = JSON.stringify({
        number: 14,
        state: "open",
        labels: [{ name: "needs-input" }],
        body: "## Open questions\n\n1. **Name**: which one?\n   - [ ] A",
        updated_at: after,
      });
      files["issue:16"] = JSON.stringify({
        number: 16,
        state: "open",
        labels: [{ name: "needs-input" }],
        body: "## Open questions\n\n1. **Size**: how big?\n   - [ ] Small\n2. Why?",
        updated_at: after,
      });
      files.installed = JSON.stringify({
        repositories: [{ full_name: "org/repo", default_branch: "main" }],
      });
      files.labelled = "[]";
      return { GITHUB_URL: github.url };
    });
    await listener.until("Closed since their run asked: org/repo#5");
    await listener.until(
      "org/repo#11: label removed meanwhile, its last run's questions set aside",
    );
    await listener.until("org/repo#14: still labelled, though the label's listing missed it");
    await listener.until("org/repo#16: still labelled, though the label's listing missed it");
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const { tasks } = await (await get("/api/state", session)).json();
    assert.deepEqual(Object.fromEntries(tasks.map((x) => [x.key, x.state])), {
      "org/repo#5": "done",
      "org/repo#8": "needs-input",
      "org/repo#11": "done",
      "org/repo#14": "needs-input",
      "org/repo#16": "needs-input",
    });
    // #14 and #16 still wait for input, since when they did, with their questions as their
    // bodies have them.
    const inputs = await storedMap(dir, "inputs");
    assert.deepEqual(
      Object.entries(inputs).map(([key, i]) => [key, i.since, i.questions?.items?.length]),
      [
        ["org/repo#14", 1000, 1],
        ["org/repo#16", 2000, 2],
      ],
    );
    // #11's label put back later: a new entry, not the one dropped at start (its time, the
    // ticks it ignored).
    const before = Date.now();
    await send(
      {
        action: "labeled",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "main" },
        issue: { number: 11, title: "Eleven", state: "open", labels: [{ name: "needs-input" }] },
        label: { name: "needs-input" },
        sender: { login: "bob", type: "User" },
      },
      "issues",
    );
    const relabelled = await until(
      async () => (await storedMap(dir, "inputs"))["org/repo#11"],
      "#11 listed again",
    );
    assert.ok(relabelled.since >= before);
    assert.equal(relabelled.ignoredTicks, undefined);
  });

  test("the orchestrator's maps (#615): a release before's files moved to the store, read back the same after a handover", async (t) => {
    const url = "https://github.com/org/repo/pull/50";
    const dryRun = { dryRun: true, by: "someone", at: 950, denials: 1, url: "https://x/1" };
    // What a release before kept in its data volume, a file per map.
    const legacy = {
      titles: { "org/repo#5": "Five", "org/repo#6": "Six", "org/repo#9": "Nine" },
      closed: { "org/repo#5": "completed", "org/repo#6": "completed", "org/repo#9": "completed" },
      // #9's failed run, its last (logged below), dismissed: kept at start.
      dismissed: { "org/repo#9": { runId: "org-repo-9-1000", by: "alice", at: 1 } },
      // Merged: not asked about again at start, as an open one is.
      pulls: { "org/repo#5": { number: 50, url, state: "merged", readyAt: 1, additions: 1 } },
      lanes: { "org/repo#5": { key: "org/repo#5", name: "Budgets", namedAt: 1, at: Date.now() } },
      "dry-runs": { "org/repo#5": dryRun },
      modes: { "org/repo#7": "review" },
      onboarding: { "org/other": { issue: 3, at: 1 } },
      conflicts: { "org/repo#8": { pr: 9, head: "h", base: "b", at: 1 } },
      requested: { "org/repo#pr-9": { head: "h", at: Date.now() } },
      // A task placed, its comments not queued at start (their author no longer allowed, say):
      // its key goes as the orchestrator starts (order.keep()), before anything else writes the
      // order.
      order: { "org/repo#99": { key: "org/repo#99" } },
    };
    const ctx = await listen(t, {}, (dir, github) => {
      for (const [name, value] of Object.entries(legacy)) {
        writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
      }
      // An item the release before #691 kept in the store's state file: moved to a file of its
      // own once this copy holds the lease.
      mkdirSync(join(dir, "store"));
      writeFileSync(
        join(dir, "store", "state.json"),
        JSON.stringify({ keys: { "modes/org/repo#3": { value: "review", expiresAt: null } } }),
      );
      pastRun(
        dir,
        "org-repo-9-1000",
        [
          {
            type: "listener",
            key: "org/repo#9",
            repo: "org/repo",
            taskMode: "work",
            startedAt: 1000,
          },
          { type: "result", is_error: true, result: "It failed.", duration_ms: 6000 },
        ],
        // Its summary where a release before #773 kept it: moved to its folder before it is read.
        { flat: true },
      );
      return { DEBOUNCE_MS: "60000", GITHUB_URL: github.url };
    });
    const { dir, port, send } = ctx;
    for (const name of Object.keys(legacy)) {
      assert.equal(existsSync(join(dir, `${name}.json`)), false, name);
      const expected =
        name === "modes"
          ? { ...legacy.modes, "org/repo#3": "review" }
          : name === "order"
            ? {}
            : legacy[name];
      assert.deepEqual(await storedMap(dir, name), expected, name);
    }
    // Each item a file of its own, out of the state file every lease renewal writes (#691).
    const saved = JSON.parse(readFileSync(join(dir, "store", "state.json"), "utf8")).keys;
    for (const name of Object.keys(legacy)) {
      assert.deepEqual(
        Object.keys(saved).filter((key) => key.startsWith(`${name}/`)),
        [],
        name,
      );
    }
    // A folder per map (#773), the summary moved into its own.
    assert.ok(existsSync(join(dir, "store", "keys", "titles%2F", "titles%2Forg%2Frepo%235")));
    assert.deepEqual(readdirSync(join(dir, "store", "keys", "summaries%2F")), [
      "summaries%2Forg-repo-9-1000",
    ]);
    assert.equal(existsSync(join(dir, "store", "keys", "summaries%2Forg-repo-9-1000")), false);
    for (const [number, id] of [
      [5, 105],
      [6, 106],
    ]) {
      const c = comment("alice");
      await send({ ...c, issue: { number }, comment: { ...c.comment, id } });
      await ctx.listener.until(`org/repo#${number}: queued (work`);
    }
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const moved = await fetch(`${base}/api/repos/org/repo/order`, {
      method: "POST",
      headers: {
        cookie: session,
        origin: "https://hooks.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ key: "org/repo#6", first: true }),
    });
    assert.equal(moved.status, 200, await moved.clone().text());
    // What the dashboard shows of the maps: titles, closed states, pull requests, lanes, the
    // run order, dry runs.
    const shown = async () => {
      const body = await (await get("/api/state", session)).json();
      return {
        tasks: body.tasks
          .map(({ key, title, closed, pr, position, dryRun, dismissed }) => ({
            key,
            title,
            closed,
            pr: pr && { number: pr.number, state: pr.state },
            ...(position && { position }),
            ...(dryRun && { dryRun }),
            ...(dismissed && { dismissed: { by: dismissed.by, at: dismissed.at } }),
          }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        lane: body.lanes["org/repo#5"]?.name,
      };
    };
    const before = await shown();
    assert.deepEqual(before, {
      tasks: [
        {
          key: "org/repo#5",
          title: "Five",
          closed: "completed",
          pr: { number: 50, state: "merged" },
          position: 2,
          dryRun,
        },
        { key: "org/repo#6", title: "Six", closed: "completed", pr: null, position: 1 },
        {
          key: "org/repo#9",
          title: "Nine",
          closed: "completed",
          pr: null,
          dismissed: { by: "alice", at: 1 },
        },
      ],
      lane: "Budgets",
    });
    // Those the dashboard doesn't show (the others it fills as it is read: a lane's parent).
    const stored = {};
    for (const name of ["modes", "onboarding", "conflicts", "requested", "order", "dismissed"]) {
      stored[name] = await storedMap(dir, name);
    }

    await ctx.handOver();
    await ctx.listener.until("org/repo#5: 1 comment(s) queued before the restart");
    await ctx.listener.until("org/repo#6: 1 comment(s) queued before the restart");
    assert.deepEqual(await shown(), before);
    for (const [name, value] of Object.entries(stored)) {
      assert.deepEqual(await storedMap(dir, name), value, name);
    }
    // Nothing written back to the data volume.
    for (const name of Object.keys(legacy)) {
      assert.equal(existsSync(join(dir, `${name}.json`)), false, name);
    }
  });

  test("the maps behind timers and comments (#616): moved to the store, a wait across a handover started once, a deadline fired once", async (t) => {
    const files = {
      "issue:77": JSON.stringify({ state: "open" }),
      "issue:80": JSON.stringify({ state: "open" }),
    };
    // What a release before kept in its data volume, a file per map.
    const legacy = {
      // A comment waiting for #80 (still open), saved before queueIds: it gets one.
      waits: {
        "org/repo#13": {
          repo: "org/repo",
          blockers: [80],
          item: {
            repo: "org/repo",
            id: "13",
            kind: "issue",
            number: 13,
            trigger: "work",
            modeLine: null,
            text: "After #80.",
            replyTo: 13,
            comment: { id: 130 },
            author: "alice",
            base: "trunk",
            eyes: null,
          },
          since: 1,
        },
      },
      // An issue waiting for input: asked about again at start (inputs.mjs sync()).
      inputs: { "org/repo#21": { since: 1, questions: null } },
      brainstorms: {
        // Its deadline passed while no copy acted: idle at the first start, and only then.
        "org/repo#20": { repo: "org/repo", number: 20, status: "active", deadline: 1 },
      },
      decisions: {
        "org/repo#pr-3": [{ decision: "merge", rule: "deny_merge", denied: true, pr: 3, at: 9 }],
      },
      reviews: { "org/repo#pr-3": { head: "abc", at: Date.now(), fixes: 1 } },
      picks: { "org/repo#9": "org-repo-9-1000" },
    };
    const ctx = await listen(t, files, (dir, github) => {
      for (const [name, value] of Object.entries(legacy)) {
        writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
      }
      return { GITHUB_URL: github.url };
    });
    const { dir, github, send } = ctx;
    for (const name of Object.keys(legacy)) {
      assert.equal(existsSync(join(dir, `${name}.json`)), false, name);
    }
    await ctx.listener.until("org/repo#20: brainstorm idle");
    assert.equal((await storedMap(dir, "brainstorms"))["org/repo#20"].status, "idle");
    assert.deepEqual(await storedMap(dir, "decisions"), legacy.decisions);
    assert.deepEqual(await storedMap(dir, "reviews"), legacy.reviews);
    const moved = (await storedMap(dir, "waits"))["org/repo#13"];
    assert.deepEqual([moved.blockers, moved.item.text], [[80], "After #80."]);
    assert.ok(moved.item.queueId);
    // A comment that waits, its text in the store without the token pasted in it by mistake.
    const token = `ghp_${"b".repeat(36)}`;
    await send(comment("alice", `Deckhand /after #77\nDo it, ${token}.`));
    await until(() => replies(github).length === 1, "the waiting reply");
    const wait = (await storedMap(dir, "waits"))["org/repo#12"];
    assert.deepEqual(wait.blockers, [77]);
    assert.equal(wait.item.text, "Do it, [redacted].");
    const stored = {};
    for (const name of ["waits", "inputs", "reviews", "brainstorms", "decisions", "picks"]) {
      stored[name] = await storedMap(dir, name);
    }

    const { output } = await ctx.handOver();
    for (const [name, value] of Object.entries(stored)) {
      assert.deepEqual(await storedMap(dir, name), value, name);
    }
    // #77 done: the next copy starts the comment, once, and the wait goes.
    files["issue:77"] = JSON.stringify({ state: "closed", state_reason: "completed" });
    await send(
      {
        action: "closed",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        issue: { number: 77, state: "closed", state_reason: "completed" },
        sender: { login: "alice" },
      },
      "issues",
    );
    await until(() => exists(join(dir, "run-args")), "the run");
    assert.match(
      readFileSync(join(dir, "run-env"), "utf8"),
      /^TASK_MESSAGE=Do it, \[redacted\]\.$/m,
    );
    await ctx.listener.until("done (ok)");
    const starting = replies(github).filter((r) => /#77 is done: starting/.test(r.body));
    assert.equal(starting.length, 1);
    assert.deepEqual(Object.keys(await storedMap(dir, "waits")), ["org/repo#13"]);
    const idle = (out) => out.split("\n").filter((l) => l.includes("org/repo#20: brainstorm idle"));
    assert.equal(idle(output).length + idle(ctx.listener.output()).length, 1);
    // Nothing written back to the data volume.
    for (const name of Object.keys(legacy)) {
      assert.equal(existsSync(join(dir, `${name}.json`)), false, name);
    }
  });
});
