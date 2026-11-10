// The orchestrator end to end, the dashboard's API (orchestrator-harness.mjs has the harness):
// tasks and logs, MCP, machines, access, the App's permissions, api/state's shape.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { APP_EVENTS, APP_PERMISSIONS } from "../listener/github-app.mjs";
import { fakeOpa } from "./helpers.mjs";
import {
  comment,
  exists,
  listen,
  options,
  pastRun,
  storedMap,
  summary,
  until,
  writeGrants,
} from "./orchestrator-harness.mjs";

describe("listener", options, () => {
  test("the dashboard shows a repo's tasks and logs to its own users, once they are known", async (t) => {
    const files = { ".deckhand.yaml": "users: [bob]\n" };
    const { dir, port, send, listener } = await listen(t, files, (dir, github) => {
      const meta = { type: "listener", key: "org/repo#pr-3", repo: "org/repo", startedAt: 1000 };
      pastRun(dir, "org-repo-pr-3-1000", [meta]);
      return { GITHUB_URL: github.url };
    });
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    // alice (the fake GitHub's browser) signs in: she is in ALLOWED_USERS.
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const keys = async () =>
      (await (await get("/api/state", session)).json()).tasks.map((task) => task.key);
    // The repo's users aren't known yet: ALLOWED_USERS decides.
    assert.deepEqual(await keys(), ["org/repo#pr-3"]);
    assert.equal(summary(dir)?.id, "org-repo-pr-3-1000");
    const open = await get("/api/runs/org-repo-pr-3-1000/stream", session);
    assert.equal(open.status, 200);
    await open.body.cancel();
    // bob's comment reads the repo's config, whose users leave alice out.
    await send(comment("bob"));
    await listener.until("done (ok)");
    assert.deepEqual(await keys(), []);
    assert.equal((await get("/api/runs/org-repo-pr-3-1000/stream", session)).status, 404);
  });

  // An MCP client of edge's /mcp, as `claude mcp add` connects one: its discovery, alice's
  // GitHub sign-in and her consent, then its token. `scope`: what it asks for (none: the
  // offered ones). → { rpc(method, params), resource }.
  async function mcpClient(port, scope = null) {
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const post = (path, body, headers = {}) =>
      fetch(base + path, { method: "POST", redirect: "manual", headers, body });
    const form = { "content-type": "application/x-www-form-urlencoded" };
    const none = await post("/mcp", "{}");
    const metadata = /resource_metadata="([^"]+)"/.exec(none.headers.get("www-authenticate"))[1];
    // The client's discovery, as the MCP authorization spec has it: the resource's metadata
    // names its authorization server, whose own names its endpoints. They are the public URL's;
    // the test reaches them at edge's port.
    const local = (url) => new URL(url).pathname;
    const protectedResource = await (await get(local(metadata))).json();
    const { resource } = protectedResource;
    const [issuer] = protectedResource.authorization_servers;
    const server = await (
      await get(`/.well-known/oauth-authorization-server${local(issuer).replace(/\/$/, "")}`)
    ).json();
    // alice signs in with GitHub, and allows a client, as `claude mcp add` gets her to.
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const redirect = "http://127.0.0.1:9/cb";
    const verifier = "v".repeat(50);
    const registered = await post(
      local(server.registration_endpoint),
      JSON.stringify({ client_name: "Claude Code", redirect_uris: [redirect] }),
      { "content-type": "application/json" },
    );
    const { client_id } = await registered.json();
    const query = new URLSearchParams({
      ...(scope && { scope }),
      response_type: "code",
      client_id,
      redirect_uri: redirect,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource,
    });
    const page = await (
      await get(`${local(server.authorization_endpoint)}?${query}`, session)
    ).text();
    const request = /name="request" value="([^"]+)"/.exec(page)[1];
    const allowed = await post(
      local(server.authorization_endpoint),
      new URLSearchParams({ request, decision: "allow" }).toString(),
      { ...form, cookie: session, origin: "https://hooks.example.com" },
    );
    const code = new URL(allowed.headers.get("location")).searchParams.get("code");
    const exchange = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    });
    const token = await post(local(server.token_endpoint), exchange.toString(), form);
    const { access_token } = await token.json();
    let id = 0;
    const rpc = async (method, params) => {
      const res = await post("/mcp", JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), {
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      });
      assert.equal(res.status, 200);
      return (await res.json()).result;
    };
    return { rpc, resource };
  }

  test("MCP (#482, #480): a client signed in through edge lists the repos, reads a log, reruns a failed run", async (t) => {
    const issue = JSON.stringify({ number: 12, title: "Fix the build", state: "open" });
    const repo = { full_name: "org/repo", html_url: "https://github.com/org/repo" };
    const installed = JSON.stringify({ repositories: [repo] });
    const { dir, github, port } = await listen(
      t,
      { "issue:12": issue, installed },
      (dir, github) => {
        const meta = { type: "listener", key: "org/repo#pr-3", repo: "org/repo", startedAt: 1000 };
        const result = { type: "result", result: "## Fixed\n\nThe typo.", duration_ms: 6000 };
        pastRun(dir, "org-repo-pr-3-1000", [meta, result]);
        // Issue #12's work run, which failed.
        const items = [{ text: "@deckhand fix it" }];
        const failed = {
          ...meta,
          key: "org/repo#12",
          kind: "issue",
          taskMode: "work",
          items,
          startedAt: 2000,
        };
        const error = {
          type: "result",
          is_error: true,
          result: "The tests fail.",
          duration_ms: 60,
        };
        pastRun(dir, "org-repo-12-2000", [failed, error]);
        return { GITHUB_URL: github.url };
      },
    );
    const base = `http://127.0.0.1:${port}`;
    const post = (path, body, headers = {}) =>
      fetch(base + path, { method: "POST", redirect: "manual", headers, body });
    // Without a token: where to sign in.
    const none = await post("/mcp", "{}");
    assert.equal(none.status, 401);
    const { rpc, resource } = await mcpClient(port);
    assert.equal(resource, "https://hooks.example.com/mcp");
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    assert.equal(init.serverInfo.name, "deckhand");
    const { tools } = await rpc("tools/list", {});
    // The read tools and the write ones (#483): a client gets both scopes by default.
    assert.equal(tools.length, 7);
    const call = (name, args) => rpc("tools/call", { name, arguments: args });
    const repos = await call("list_repos", {});
    assert.deepEqual(
      repos.structuredContent.repos.map((r) => r.repo),
      ["org/repo"],
    );
    // The failed task, as the client sees it before it reruns it.
    const listed = await call("list_tasks", {});
    assert.deepEqual(
      listed.structuredContent.tasks.map((task) => [task.key, task.state, !!task.rerunnable]),
      [
        ["org/repo#12", "error", true],
        ["org/repo#pr-3", "done", false],
      ],
    );
    const tasks = await call("list_tasks", { state: "done" });
    assert.deepEqual(
      tasks.structuredContent.tasks.map((task) => [task.key, task.state]),
      [["org/repo#pr-3", "done"]],
    );
    const runs = await call("list_runs", { task: "org/repo#pr-3" });
    assert.deepEqual(
      runs.structuredContent.runs.map((r) => r.id),
      ["org-repo-pr-3-1000"],
    );
    // The log, read at the runner through the orchestrator.
    const log = await call("get_run_log", { runId: "org-repo-pr-3-1000" });
    assert.match(log.content[0].text, /= result \(ok, 0\.1 min\):\n## Fixed/);
    // The write tools reach the work area (#483): its refusal is the tool's error.
    const rerun = await call("rerun", { runId: "nope" });
    assert.equal(rerun.isError, true);
    assert.equal(rerun.content[0].text, "No run nope among those you see.");
    // The failed run again, as the dashboard's Rerun: the App's comment (an MCP client's), then the run.
    const again = await call("rerun", { runId: "org-repo-12-2000" });
    assert.equal(again.isError, undefined, again.content[0].text);
    assert.equal(again.content[0].text, "Rerun of #12 queued.");
    const posted = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.match(JSON.parse(posted.body).body, /^Rerun from an MCP client by @alice.*failed\./);
    await until(() => exists(join(dir, "run-env")), "#12's rerun");
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_ISSUE=12$/m);
  });

  test("machines (#595, #596, #597, #600): a machine registered through edge is offered the repositories that opt in, claims the issue routed to it and reports on its run, whose tool call its owner allows on the issue, which a handover keeps", async (t) => {
    const repos = ["org/repo", "org/other", "org/plain"].map((full_name) => ({
      full_name,
      html_url: `https://github.com/${full_name}`,
      default_branch: "trunk",
    }));
    const listened = await listen(
      t,
      {
        installed: JSON.stringify({ repositories: repos }),
        // Both opt in; the operator's policies grant org/repo alone. org/plain has no block.
        ".deckhand.yaml": "machines:\n  labels: [unreal]\n",
        "org/other:.deckhand.yaml": "machines: true\n",
      },
      (dir, github) => {
        writeGrants(dir, ["machines"]);
        return { GITHUB_URL: github.url };
      },
    );
    const { port, dir, send, github } = listened;
    // A machine's driver asks for deckhand:machine alone: its tools, none of the others.
    const { rpc } = await mcpClient(port, "deckhand:machine");
    const { tools } = await rpc("tools/list", {});
    assert.deepEqual(
      tools.map((x) => x.name),
      [
        "register_machine",
        "heartbeat",
        "claim",
        "post_events",
        "next_message",
        "ask",
        "finish",
        "approve_permission",
        "release",
        "unregister_machine",
      ],
    );
    const call = (name, args) => rpc("tools/call", { name, arguments: args });
    assert.equal((await call("list_repos", {})).isError, true);
    const registered = await call("register_machine", {
      name: "studio",
      labels: ["unreal", "gpu"],
      repos: ["org/*"],
    });
    assert.equal(registered.isError, undefined, registered.content[0].text);
    const { machine, offered } = registered.structuredContent;
    assert.deepEqual(offered, [{ repo: "org/repo", labels: ["unreal"] }]);
    const beat = await call("heartbeat", { machine: machine.id });
    assert.equal(beat.structuredContent.machine.online, true);
    // Alice routes #12 to it: no sandbox starts, the machine's claim takes it, then gives it back.
    await send(comment("alice", "Deckhand\n/machine studio\nBuild it."));
    await listened.listener.until("org/repo#12: queued");
    const claimed = await call("claim", { machine: machine.id, model: "opus" });
    assert.equal(claimed.isError, undefined, claimed.content[0].text);
    const { work } = claimed.structuredContent;
    assert.deepEqual([work.repository, work.issue, work.mode], ["org/repo", 12, "work"]);
    assert.equal(work.message, "Build it.");
    assert.equal(exists(join(dir, "run-env")), null);
    const renewed = await call("heartbeat", { machine: machine.id, runs: [work.run] });
    assert.deepEqual(
      renewed.structuredContent.claims.map((c) => [c.run, c.key]),
      [[work.run, "org/repo#12"]],
    );
    // Given back: its run ends as interrupted, the issue told.
    const released = await call("release", { machine: machine.id, run: work.run });
    assert.equal(released.structuredContent.key, "org/repo#12");
    const comments = "/repos/org/repo/issues/12/comments";
    const told = await github.waitFor((r) => r.method === "POST" && r.path === comments);
    assert.match(JSON.parse(told.body).body, /^studio's run was interrupted: studio released it/);
    // Claimed again: its run's record, as a sandbox run's, and its output through edge (a line
    // past the 64 KB of the other tools' calls: a file its agent read).
    const again = (await call("claim", { machine: machine.id, model: "opus" })).structuredContent
      .work;
    assert.equal(again.resume, true);
    const big = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(100_000) }],
      },
    });
    const posted = await call("post_events", {
      machine: machine.id,
      run: again.run,
      lines: [
        big,
        JSON.stringify({ type: "result", is_error: false, result: "Built.", duration_ms: 6000 }),
      ],
      from: 0,
    });
    assert.equal(posted.isError, undefined, posted.content[0].text);
    assert.equal(posted.structuredContent.next, 2);
    // Its agent asks for a tool call: a comment on the issue asks alice, whose `/allow` there
    // reaches the call waiting.
    const asking = call("approve_permission", {
      machine: machine.id,
      run: again.run,
      tool_name: "Bash",
      input: { command: "make level" },
      tool_use_id: "toolu_1",
    });
    const asked = await github.waitFor(
      (r) =>
        r.method === "POST" &&
        r.path === comments &&
        /asks to use a tool/.test(JSON.parse(r.body).body),
    );
    assert.match(JSON.parse(asked.body).body, /\n```text\nBash: make level\n```\n/);
    await send(comment("alice", "/allow"));
    const allowed = await asking;
    assert.equal(allowed.isError, undefined, allowed.content[0].text);
    assert.deepEqual(JSON.parse(allowed.content[0].text), {
      behavior: "allow",
      updatedInput: { command: "make level" },
    });
    // A handover: the next copy keeps the run and its claim, and the driver goes on with it.
    await listened.handOver();
    const kept = await call("heartbeat", { machine: machine.id, runs: [again.run] });
    assert.deepEqual(
      kept.structuredContent.claims.map((c) => c.run),
      [again.run],
    );
    const inbox = await call("next_message", { machine: machine.id, run: again.run });
    assert.equal(inbox.structuredContent.closed, true);
    const finished = await call("finish", { machine: machine.id, run: again.run, outcome: "ok" });
    assert.equal(finished.isError, undefined, finished.content[0].text);
    assert.equal(finished.structuredContent.status, "ok");
    const reply = await github.waitFor(
      (r) => r.method === "POST" && r.path === comments && /^Built\./.test(JSON.parse(r.body).body),
    );
    assert.match(JSON.parse(reply.body).body, /🤖 Claude opus · on studio · 0\.1 min/);
    // Its claim is over with it.
    const over = await call("heartbeat", { machine: machine.id });
    assert.deepEqual(over.structuredContent.claims, []);
    const gone = await call("unregister_machine", { machine: machine.id });
    assert.equal(gone.isError, undefined);
    assert.equal((await call("heartbeat", { machine: machine.id })).isError, true);
  });

  test("access (#731): a login with no action sees nothing, starts nothing, its routes 404 and 403", async (t) => {
    // The operator's access.rego replaces Deckhand's: decided by the policy service, whose opa
    // gives bob everything and alice nothing (not even server-wide).
    const opa = fakeOpa({ accessFor: (doc) => (doc.user.login === "bob" ? ["*"] : []) });
    const { dir, port, send, listener } = await listen(
      t,
      undefined,
      (dir, github) => {
        mkdirSync(join(dir, "grants", "policy"), { recursive: true });
        writeFileSync(
          join(dir, "grants", "policy", "access.rego"),
          'package deckhand\n\nbindings := [{"users": ["bob"], "repos": ["*/*"], "role": "operator"}]\n',
        );
        return { GITHUB_URL: github.url };
      },
      { opa },
    );
    // alice is in ALLOWED_USERS, but has no action here: no run, and nothing said.
    await send(comment("alice"));
    await listener.until("org/repo#12: alice has no action here");
    assert.equal(exists(join(dir, "run-env")), null);
    // bob's comment runs.
    await send(comment("bob"));
    await listener.until("done (ok)");
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie, init = {}) =>
      fetch(base + path, { redirect: "manual", ...init, headers: { cookie, ...init.headers } });
    // alice (the fake GitHub's browser) signs in.
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const seen = await (await get("/api/state", session)).json();
    assert.deepEqual(seen.tasks, []);
    assert.deepEqual(seen.inboxes, {});
    // Totals stay: numbers without names.
    assert.equal(typeof seen.maxParallel, "number");
    const run = summary(dir)?.id;
    assert.match(run, /-org-repo-12-/);
    assert.equal((await get(`/api/runs/${run}/stream`, session)).status, 404);
    assert.equal((await get("/api/repos/org/repo/issues", session)).status, 404);
    const listed = await (await get("/api/repos", session)).json();
    assert.deepEqual(listed.repos, []);
    for (const path of ["/api/server", "/api/health"]) {
      assert.equal((await get(path, session)).status, 403, path);
    }
    const sync = await get("/api/sync", session, {
      method: "POST",
      headers: { origin: "https://hooks.example.com" },
    });
    assert.equal(sync.status, 403);
    const status = await get("/status", session, { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.doesNotMatch((await status.json()).reasons.join("\n"), /org\/repo/);
  });

  test("the permissions the App and its installations lack: warned at start, and on api/repos", async (t) => {
    const installation = {
      id: 7,
      account: { login: "org" },
      html_url: "https://github.com/organizations/org/settings/installations/7",
      permissions: { ...APP_PERMISSIONS, actions: undefined, discussions: undefined },
    };
    const { port, listener } = await listen(
      t,
      {
        app: JSON.stringify({
          slug: "deckhand",
          owner: { login: "org", type: "Organization" },
          events: APP_EVENTS,
          permissions: { ...APP_PERMISSIONS, discussions: undefined },
        }),
        installations: JSON.stringify([installation]),
      },
      (dir, github) => ({ GITHUB_URL: github.url }),
    );
    await listener.until("lacks the permission discussions: write");
    // Listed at start, before anyone opens the dashboard.
    const start = `installation on org lacks actions: write: an owner of the account accepts the new permissions on ${installation.html_url}`;
    await listener.until(start);
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
    const { app } = await (await get("/api/repos", session)).json();
    // Logged once: read again with the listing, neither warning is new.
    const out = listener.output();
    assert.equal(out.split("lacks the permission discussions: write").length, 2);
    assert.equal(out.split(start).length, 2);
    assert.deepEqual(app.missingEvents, []);
    assert.deepEqual(app.missingPermissions, ["discussions: write"]);
    // What the App lacks is said for the App alone.
    assert.deepEqual(app.installations, [
      { account: "org", url: installation.html_url, missing: ["actions: write"] },
    ]);
  });

  // An edge slower to answer than the orchestrator to start: what it does at start once the App
  // is known waits for it, rather than waiting for the next listing (a dashboard's).
  test("the App learned after the start: the start's listing then, and its warnings", async (t) => {
    const installation = {
      id: 7,
      account: { login: "org" },
      html_url: "https://github.com/organizations/org/settings/installations/7",
      permissions: { ...APP_PERMISSIONS, actions: undefined },
    };
    const { listener } = await listen(
      t,
      {
        app: JSON.stringify({ slug: "deckhand", events: APP_EVENTS, permissions: APP_PERMISSIONS }),
        installations: JSON.stringify([installation]),
      },
      (dir, github) => ({ GITHUB_URL: github.url }),
      { appRefused: 1 },
    );
    await listener.until("Edge: the App (");
    await listener.until(
      `installation on org lacks actions: write: an owner of the account accepts the new permissions on ${installation.html_url}`,
    );
  });

  test("api/state: a run's questions stop waiting once its issue closes, its pull request merges, or a pull request's label comes off", async (t) => {
    const asked =
      "<!-- needs-input -->\n## Needs your input\n\n1. **Name**: which one?\n   - [ ] A";
    const { dir, port, send, listener } = await listen(t, {}, (dir, github) => {
      for (const [id, key] of [
        ["org-repo-5-1000", "org/repo#5"],
        ["org-repo-pr-6-1000", "org/repo#pr-6"],
        ["org-repo-9-1000", "org/repo#9"],
        ["org-repo-12-1000", "org/repo#12"],
        ["org-repo-13-1000", "org/repo#13"],
      ]) {
        pastRun(dir, id, [
          // #5 and #9 auto-picked: their close ends the pick (picks.json).
          {
            type: "listener",
            key,
            repo: "org/repo",
            taskMode: "work",
            startedAt: 1000,
            ...(["org/repo#5", "org/repo#9"].includes(key) && { autoPickup: true }),
          },
          { type: "result", result: asked, duration_ms: 6000 },
        ]);
      }
      return { GITHUB_URL: github.url };
    });
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
    const states = async () =>
      Object.fromEntries(
        (await (await get("/api/state", session)).json()).tasks.map((x) => [x.key, x.state]),
      );
    assert.deepEqual(await states(), {
      "org/repo#5": "needs-input",
      "org/repo#pr-6": "needs-input",
      "org/repo#9": "needs-input",
      "org/repo#12": "needs-input",
      "org/repo#13": "needs-input",
    });
    const repository = { full_name: "org/repo", default_branch: "main" };
    const installation = { id: 7 };
    const sender = { login: "bob", type: "User" };
    // Issue #5 closed, the label taken off pull request #6, and pull request #19, which closes
    // #9, merged with #9 left open.
    const closed = { number: 5, title: "An idea", state: "closed", state_reason: "completed" };
    await send({ action: "closed", installation, repository, sender, issue: closed }, "issues");
    const merged = {
      number: 19,
      title: "Nine",
      state: "closed",
      merged: true,
      // After the runs asked (their logs' time): a close from before says nothing of them.
      merged_at: new Date(Date.now() + 60_000).toISOString(),
      body: "Closes #9",
      html_url: "https://github.com/org/repo/pull/19",
      head: { ref: "issue-9-nine", repo: { full_name: "org/repo" } },
    };
    await send(
      { action: "closed", installation, repository, sender, pull_request: merged },
      "pull_request",
    );
    await listener.until("org/repo#9: closed, its last run's questions set aside");
    assert.deepEqual(await storedMap(dir, "picks"), {
      "org/repo#5": "org-repo-5-1000",
      "org/repo#9": "org-repo-9-1000",
    });
    // Pull request #22, which would close #12, closed without merging: #12 still asks. Issue
    // #13's `closed`, redelivered from before its run asked: #13 still asks.
    await send(
      {
        action: "closed",
        installation,
        repository,
        sender,
        pull_request: {
          ...merged,
          number: 22,
          merged: false,
          merged_at: null,
          closed_at: new Date(Date.now() + 60_000).toISOString(),
          body: "Closes #12",
        },
      },
      "pull_request",
    );
    const stale = { number: 13, state: "closed", closed_at: "2000-01-01T00:00:00Z" };
    await send({ action: "closed", installation, repository, sender, issue: stale }, "issues");
    const pull = { number: 6, title: "A change", state: "open", labels: [] };
    const label = { name: "needs-input" };
    await send(
      { action: "unlabeled", installation, repository, sender, pull_request: pull, label },
      "pull_request",
    );
    await listener.until("org/repo#pr-6: label removed, its last run's questions set aside");
    assert.deepEqual(Object.keys(await storedMap(dir, "dismissed")).sort(), [
      "org/repo#5",
      "org/repo#9",
      "org/repo#pr-6",
    ]);
    assert.deepEqual(await states(), {
      "org/repo#5": "done",
      "org/repo#pr-6": "done",
      "org/repo#9": "done",
      "org/repo#12": "needs-input",
      "org/repo#13": "needs-input",
    });
    // The label put back on #6: its questions ask again.
    await send(
      { action: "labeled", installation, repository, sender, pull_request: pull, label },
      "pull_request",
    );
    await listener.until("org/repo#pr-6: label put back, its last run's questions wait again");
    assert.equal((await states())["org/repo#pr-6"], "needs-input");
  });

  test("the dashboard and its logs are for allowed users signed in with GitHub", async (t) => {
    // GitHub's sign-in pages are the fake GitHub too. A built dashboard, and an older log with
    // no title.
    const { github, port, send, listener } = await listen(t, {}, (dir, github) => {
      const dist = join(dir, "dist");
      mkdirSync(join(dist, "assets"), { recursive: true });
      writeFileSync(join(dist, "index.html"), "<title>Deckhand</title>");
      writeFileSync(join(dist, "assets", "app-1a2b.js"), "export {}");
      const meta = { type: "listener", key: "org/repo#pr-3", repo: "org/repo", startedAt: 1000 };
      const result = { type: "result", result: "## Fixed\n\nThe typo.", duration_ms: 6000 };
      pastRun(dir, "org-repo-pr-3-1000", [meta, result]);
      // A run that stopped to ask.
      const asked = {
        type: "result",
        result:
          "<!-- needs-input -->\n## Needs your input\n\n1. **Name**: which one?\n   - [ ] A (recommended)\n   - [ ] B",
        duration_ms: 6000,
      };
      pastRun(dir, "org-repo-pr-4-500", [{ ...meta, key: "org/repo#pr-4", startedAt: 500 }, asked]);
      // An operator policy: its text goes to the config endpoint only (repos.test.mjs), never
      // to api/state.
      mkdirSync(join(dir, "grants", "policy"), { recursive: true });
      writeFileSync(
        join(dir, "grants", "policy", "op.rego"),
        "package deckhand\n# op-policy-text\n",
      );
      // What the policies decided about #pr-3 (decisions.mjs).
      const refused = { decision: "merge", rule: "deny_merge", denied: true, pr: 3, at: 900 };
      writeFileSync(
        join(dir, "decisions.json"),
        JSON.stringify({ "org/repo#pr-3": [{ ...refused, messages: ["too big"] }] }),
      );
      // And its last `/mode policy` dry run.
      const dryRun = { dryRun: true, by: "someone", at: 950, denials: 1, url: "https://x/1" };
      writeFileSync(join(dir, "dry-runs.json"), JSON.stringify({ "org/repo#pr-3": dryRun }));
      return { GITHUB_URL: github.url, DASHBOARD_DIR: dist };
    });
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    // Signed out: a sign-in page, and nothing from the API.
    const home = await get("/");
    assert.equal(home.status, 200);
    const signIn = await home.text();
    assert.match(signIn, /Sign in with GitHub/);
    // The listener's own pages: no script, their one style by its hash, never in a frame.
    const style = /<style>([^]*?)<\/style>/.exec(signIn)[1];
    const styleHash = createHash("sha256").update(style).digest("base64");
    assert.equal(
      home.headers.get("content-security-policy"),
      `default-src 'none'; img-src 'self'; style-src 'sha256-${styleHash}'; frame-ancestors 'none'`,
    );
    assert.equal(home.headers.get("x-content-type-options"), "nosniff");
    const refused = await get("/api/state");
    assert.equal(refused.status, 401);
    assert.equal((await get("/api/server")).status, 401);
    assert.equal((await get("/api/health")).status, 401);
    assert.equal(refused.headers.get("x-content-type-options"), "nosniff");
    for (const path of ["/assets/app-1a2b.js", "/index.html", "/nope.js"]) {
      assert.equal((await get(path)).status, 401);
    }
    // A run, so there is a log to stream; its title comes with the webhook.
    const titled = comment("alice");
    titled.issue.title = "Fix the queue";
    await send(titled);
    await listener.until("done (ok)");

    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    assert.equal(to.pathname, "/login/oauth/authorize");
    assert.equal(to.searchParams.get("redirect_uri"), "https://hooks.example.com/auth/callback");
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    assert.equal(back.status, 302);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    assert.ok(github.requests.some((r) => r.path === "/user" && r.auth === "Bearer user-token"));

    const index = await get("/", session);
    assert.equal(index.headers.get("cache-control"), "no-store");
    // The dashboard, and everything else: its own files only, never in a frame, never sniffed.
    for (const answer of [index, await get("/auth/login")]) {
      assert.equal(
        answer.headers.get("content-security-policy"),
        "default-src 'self'; frame-ancestors 'none'",
      );
      assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
    }
    assert.match(await index.text(), /<title>Deckhand<\/title>/);
    const asset = await get("/assets/app-1a2b.js", session);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /^text\/javascript/);
    assert.match(asset.headers.get("cache-control"), /immutable/);
    assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
    await asset.text();
    // What is outside the build: static.test.mjs.
    assert.equal((await get("/assets/nope.js", session)).status, 404);
    const board = await (await get("/api/state", session)).json();
    assert.equal(board.user, "alice");
    assert.ok(!JSON.stringify(board).includes("op-policy-text"));
    assert.equal(board.githubUrl, github.url);
    // The shape dashboard/src/types/ expects: change both together.
    assertShape(board, STATE_KEYS, "State");
    assertShape(board.server, SERVER_KEYS, "ServerInfo");
    // org/repo's: its task, done, is still known.
    assert.deepEqual(Object.keys(board.repoSlots), ["org/repo"]);
    for (const slots of Object.values(board.repoSlots)) {
      assertShape(slots, REPO_SLOTS_KEYS, "RepoSlots");
    }
    // What alice may do (#732): Deckhand's default policies give every action.
    assertShape(board.access, ACCESS_KEYS, "Access");
    assert.deepEqual(board.access.server, ["server:read", "server:sync"]);
    for (const repo of Object.values(board.access.repos)) {
      assertShape(repo, REPO_ACCESS_KEYS, "RepoAccess");
      assert.deepEqual(repo.starts, ["*"]);
    }
    // Settings › Access: who has what.
    const report = await (await get("/api/access", session)).json();
    assertShape(report, ACCESS_REPORT_KEYS, "AccessReport");
    assert.deepEqual(
      report.users.map((u) => u.login),
      ["alice", "bob"],
    );
    for (const u of report.users) {
      assertShape(u, USER_ACCESS_KEYS, "UserAccess");
      for (const d of [u.server, ...u.repos])
        assertShape(d, ACCESS_DECISION_KEYS, "AccessDecision");
    }
    // Built from source: no version to link, and up since this listener started.
    assert.deepEqual([board.server.version, board.server.source], ["dev", ""]);
    assert.ok(board.server.startedAt <= board.now);
    // How it is set up, for Settings › Server (status.mjs serverSetup()).
    const setup = await (await get("/api/server", session)).json();
    assertShape(setup, SETUP_KEYS, "ServerSetup");
    assert.deepEqual(setup.allowedUsers, ["alice", "bob"]);
    // The services' health, which the orchestrator probes (health.mjs): never their URLs.
    const health = await (await get("/api/health", session)).json();
    assertShape(health, HEALTH_KEYS, "Health");
    for (const s of health.services) assertShape(s, SERVICE_HEALTH_KEYS, "ServiceHealth");
    const states = Object.fromEntries(health.services.map((s) => [s.name, s.state]));
    assert.equal(states.orchestrator, "starting");
    assert.equal(states.edge, "starting");
    assert.doesNotMatch(JSON.stringify(health), /127\.0\.0\.1|http:/);
    for (const t of board.tasks) {
      assertShape(t, TASK_KEYS, "Task");
      for (const r of t.runs) assertShape(r, RUN_KEYS, "Run");
    }
    const [task] = board.tasks;
    assert.deepEqual(
      [task.key, task.project, task.state, task.title],
      ["org/repo#12", "org", "done", "Fix the queue"],
    );
    assert.equal(task.runs[0].title, "Fix the queue");
    assert.equal(task.runs[0].summary, "All done.");
    // The older task's title is fetched once, then shows.
    await github.waitFor((r) => r.method === "GET" && r.path === "/repos/org/repo/issues/3");
    const older = async () =>
      (await (await get("/api/state", session)).json()).tasks.find(
        (x) => x.key === "org/repo#pr-3",
      );
    let fetched = await older();
    for (let i = 0; i < 100 && !fetched.title; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      fetched = await older();
    }
    assert.equal(fetched.title, "An older pull request");
    assert.equal(fetched.runs[0].summary, "The typo.");
    assert.deepEqual(fetched.decisions, [
      {
        decision: "merge",
        rule: "deny_merge",
        denied: true,
        pr: 3,
        at: 900,
        messages: ["too big"],
      },
    ]);
    assert.deepEqual(fetched.dryRun, {
      dryRun: true,
      by: "someone",
      at: 950,
      denials: 1,
      url: "https://x/1",
    });
    // Waiting for input: the questions of the run that stopped to ask, and of an issue's body.
    const tasks = async () => (await (await get("/api/state", session)).json()).tasks;
    const stopped = (await tasks()).find((x) => x.key === "org/repo#pr-4");
    assert.equal(stopped.state, "needs-input");
    assert.deepEqual(stopped.questions, {
      source: "run",
      runId: "org-repo-pr-4-500",
      items: [
        {
          title: "Name",
          text: "which one?",
          options: [
            { label: "A", recommended: true, checked: false },
            { label: "B", recommended: false, checked: false },
          ],
        },
      ],
      raw: "1. **Name**: which one?\n   - [ ] A (recommended)\n   - [ ] B",
    });
    await send(
      {
        action: "opened",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        issue: {
          number: 20,
          title: "An idea",
          state: "open",
          body: "## Open questions\n\nWhich colour?",
          user: { login: "alice", type: "User" },
          labels: [],
        },
        sender: { login: "alice", type: "User" },
      },
      "issues",
    );
    await listener.until("org/repo#20: open questions, labelled");
    const filed = (await tasks()).find((x) => x.key === "org/repo#20");
    assert.deepEqual(filed.questions, { source: "issue", items: null, raw: "Which colour?" });
    for (const x of [stopped, filed]) assertShape(x.questions, QUESTIONS_KEYS, "Questions");
    // Its pull request too, without a readyAt: nothing to notify.
    for (let i = 0; i < 100 && !fetched.pr; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      fetched = await older();
    }
    assert.deepEqual(fetched.pr, {
      number: 3,
      url: "https://github.com/org/repo/pull/3",
      state: "ready",
      readyAt: null,
    });

    // A pull request that closes #12, from its webhooks: draft, then ready for review.
    const pr = (action, draft) => ({
      action,
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      pull_request: {
        number: 13,
        html_url: "https://github.com/org/repo/pull/13",
        body: "Closes #12",
        state: "open",
        draft,
        head: { ref: "issue-12-fix", repo: { full_name: "org/repo" } },
        additions: 86,
        deletions: 19,
        changed_files: 4,
        commits: draft ? 2 : 3,
      },
      sender: { login: "deckhand[bot]" },
    });
    await send(pr("opened", true), "pull_request");
    await listener.until("org/repo#12: pull request #13 draft");
    await send(pr("ready_for_review", false), "pull_request");
    await listener.until("org/repo#12: pull request #13 ready");
    const ready = (await (await get("/api/state", session)).json()).tasks.find(
      (x) => x.key === "org/repo#12",
    );
    assert.equal(ready.pr.number, 13);
    assert.equal(ready.pr.state, "ready");
    assert.ok(ready.pr.readyAt > 0);
    // Its size and commit count, as the last delivery had them.
    assert.deepEqual(
      [ready.pr.additions, ready.pr.deletions, ready.pr.changedFiles, ready.pr.commits],
      [86, 19, 4, 3],
    );
    assert.equal(ready.closed, null);
    // #12 closed as completed: the graph shows it implemented.
    await send(
      {
        action: "closed",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        issue: { number: 12, state: "closed", state_reason: "completed" },
        sender: { login: "alice" },
      },
      "issues",
    );
    let closed = null;
    for (let i = 0; i < 100 && !closed; i++) {
      const all = (await (await get("/api/state", session)).json()).tasks;
      closed = all.find((x) => x.key === "org/repo#12").closed;
      if (!closed) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(closed, "completed");
    const stream = await get(`/api/runs/${task.runs[0].id}/stream`, session);
    assert.equal(stream.status, 200);
    assert.match(await stream.text(), /event: end/);
    assert.equal((await get(`/api/runs/${task.runs[0].id}/stream`)).status, 401);
    // Sync: the deliveries and pull requests asked again, from this dashboard only, not twice
    // in a row.
    const sync = (headers) =>
      fetch(`${base}/api/sync`, { method: "POST", headers: { cookie: session, ...headers } });
    assert.equal((await sync({ origin: "https://evil.example" })).status, 403);
    // The listener's own, at start, is the last one until then.
    const lastSync = async () => (await (await get("/api/state", session)).json()).lastSync;
    let atStart = null;
    for (let i = 0; i < 100 && !atStart; i++) {
      atStart = await lastSync();
      if (!atStart) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(atStart, "the sync at start is recorded");
    assert.equal(atStart.by, null);
    assertShape(atStart, SYNC_KEYS, "SyncResult");
    const synced = await sync({ origin: "https://hooks.example.com" });
    assert.equal(synced.status, 200);
    const body = await synced.json();
    assert.deepEqual(
      { ...body, at: 0 },
      {
        at: 0,
        by: "alice",
        redelivered: 0,
        pulls: 0,
        conflicts: 0,
      },
    );
    assert.ok(body.at >= atStart.at);
    // Every browser sees it, not only the one that asked.
    assert.deepEqual(await lastSync(), body);
    assert.equal((await sync({ origin: "https://hooks.example.com" })).status, 429);
  });

  // dashboard/src/types/, key by key: [required, optional].
  const STATE_KEYS = [
    [
      "user",
      "tasks",
      "edges",
      "blockers",
      "states",
      "running",
      "queued",
      "maxParallel",
      "repoSlots",
      "githubUrl",
      "server",
      "lastSync",
      "now",
    ],
    ["inboxes", "lanes", "plans", "access"],
  ];

  const ACCESS_KEYS = [["server", "repos"], []];

  const REPO_SLOTS_KEYS = [["running", "queued", "max", "own"], []];

  const REPO_ACCESS_KEYS = [["actions", "starts", "startsDenied"], []];

  const ACCESS_REPORT_KEYS = [["users", "repos", "error"], []];

  const USER_ACCESS_KEYS = [["login", "server", "repos"], []];

  const ACCESS_DECISION_KEYS = [["actions", "denied", "error", "outside"], ["repo"]];

  const SERVER_KEYS = [["version", "startedAt", "node", "source"], []];

  const SYNC_KEYS = [["at", "by", "redelivered", "pulls", "conflicts"], ["error"]];

  const SETUP_KEYS = [["engine", "proxy", "grants", "allowedUsers", "allowedRepos"], ["claude"]];

  const HEALTH_KEYS = [["checkedAt", "services"], []];

  const SERVICE_HEALTH_KEYS = [["name", "state", "startedAt", "version", "checkedAt"], ["reason"]];

  const TASK_KEYS = [
    [
      "key",
      "repo",
      "project",
      "number",
      "title",
      "kind",
      "mode",
      "replyTo",
      "state",
      "since",
      "updatedAt",
      "closed",
      "pr",
      "rerunnable",
      "dismissed",
      "runs",
    ],
    [
      "deadline",
      "waitingFor",
      "questions",
      "waitForAnswers",
      "decisions",
      "dryRun",
      "position",
      "startsFirst",
      "canWait",
    ],
  ];

  const QUESTIONS_KEYS = [["source", "items", "raw"], ["runId"]];

  const RUN_KEYS = [
    [
      "id",
      "key",
      "kind",
      "title",
      "repo",
      "replyTo",
      "mode",
      "taskMode",
      "startedAt",
      "finishedAt",
      "status",
    ],
    [
      "reason",
      "round",
      "rounds",
      "agent",
      "provider",
      "credential",
      "auth",
      "fallback",
      "picked",
      "model",
      "effort",
      "speed",
      "speedNote",
      "phase",
      "summary",
      "delivered",
      "branch",
      "lastPushAt",
      "lastPushHead",
      "user",
      "usage",
      "exitCode",
      "capabilities",
    ],
  ];

  function assertShape(value, [required, optional], name) {
    const keys = Object.keys(value);
    const unknown = keys.filter((k) => !required.includes(k) && !optional.includes(k));
    assert.deepEqual(unknown, [], `${name}: keys types/ doesn't have`);
    const missing = required.filter((k) => !keys.includes(k));
    assert.deepEqual(missing, [], `${name}: keys types/ requires`);
  }
});
