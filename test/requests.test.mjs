// requests.mjs (#479): a chat's agent's requests for more permissions, from the broker's stream
// to its owner's answer and back to the broker, with an injected clock, store and chat (whose
// verdicts and approvals chats.test.mjs and profiles.test.mjs cover against a real ceiling).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRequests,
  fenced,
  inputLine,
  REASON_MAX,
  reasonLine,
  REQUESTS_KEY,
} from "../listener/requests.mjs";
import { openStore } from "../lib/store.mjs";

const RUN = "org-repo-chat-0123456789abcdef-1";
const CHAT = "0123456789abcdef";
const ID = (n) => `${String(n).padStart(2, "0")}00112233aabbcc`;

function fakeClock(start = 1_000_000) {
  const clock = { at: start, timers: new Set() };
  clock.now = () => clock.at;
  clock.setTimer = (fn, ms) => {
    const timer = { fn, at: clock.at + ms };
    clock.timers.add(timer);
    return timer;
  };
  clock.clearTimer = (timer) => clock.timers.delete(timer);
  clock.advance = (ms) => {
    clock.at += ms;
    for (const timer of [...clock.timers].sort((a, b) => a.at - b.at)) {
      if (timer.at > clock.at || !clock.timers.has(timer)) continue;
      clock.timers.delete(timer);
      timer.fn();
    }
  };
  return clock;
}

// A chat's run going, and what the chat decides: `verdicts`, kind → requestVerdict()'s.
function setup({ store = openStore("memory:"), verdicts = {}, failing = false } = {}) {
  const clock = fakeClock();
  const told = [];
  const notes = [];
  const granted = [];
  const task = {
    kind: "chat",
    id: `chat-${CHAT}`,
    owner: "alice",
    live: { id: RUN, key: `org/repo#chat-${CHAT}`, hosts: ["github.com"] },
  };
  const ctx = {
    config: { chatPermissionMs: 10 * 60_000 },
    log: () => {},
    store,
    tasks: new Map([[`org/repo#chat-${CHAT}`, task]]),
    broker: { runOf: (run) => run === RUN && { note: (m) => notes.push(m) } },
    brokerService: {
      answerPermission: async (run, id, answer) => {
        if (failing) throw new Error("the broker is away");
        told.push({ run, id, ...answer });
        return true;
      },
    },
    chats: {
      subjectOf: (t) => (t.kind === "chat" ? { id: CHAT } : null),
      decideRequest: async (_task, request) => {
        // A promise: a decision that takes its time (the test resolves it).
        const verdict = await verdicts[request.kind];
        if (verdict instanceof Error) throw verdict;
        return { ceiling: { hosts: [] }, ...verdict };
      },
      grantRequest: async (_task, record, scope) => {
        granted.push({ id: record.id, scope, adds: record.adds });
        // The chat's save, which a test may hold.
        await ctx.saving;
        return record.live ? "It applies now." : "It applies at the next start.";
      },
    },
  };
  const requests = createRequests(ctx, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    retryMs: 1000,
  });
  return { requests, ctx, clock, told, notes, granted, task, store };
}

const ASK = {
  verdict: "ask",
  what: "registry.npmjs.org",
  adds: { hosts: ["registry.npmjs.org"] },
  live: true,
};
const event = (n, kind = "host", extra = {}) => ({
  run: RUN,
  id: ID(n),
  kind,
  value: "registry.npmjs.org",
  reason: "npm ci",
  ...extra,
});
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("beyond the ceiling: refused at once, its reason told to the agent, nobody asked", async () => {
  const message =
    "Refused: evil.example isn't among the hosts the operator grants this repository.";
  const { requests, told, notes } = setup({ verdicts: { host: { verdict: "beyond", message } } });
  await requests.received(event(1, "host", { value: "evil.example" }));
  await settled();
  assert.deepEqual(told, [{ run: RUN, id: ID(1), state: "refused", message }]);
  assert.deepEqual(requests.waitingFor(CHAT), []);
  assert.match(notes.at(-1), /^Permission host evil\.example: Refused: /);
});

test("what the sandbox has already is granted, what its profile has applied first, without asking", async () => {
  const { requests, told, granted } = setup({
    verdicts: {
      github: { verdict: "given", message: "Granted: this sandbox reads GitHub already." },
      host: { ...ASK, verdict: "saved" },
    },
  });
  await requests.received(event(1, "github", { value: "read" }));
  await requests.received(event(2));
  await settled();
  assert.deepEqual(
    told.map((t) => [t.id, t.state]),
    [
      [ID(1), "granted"],
      [ID(2), "granted"],
    ],
  );
  assert.match(told[1].message, /as this chat's permissions allow\. It applies now\.$/);
  assert.deepEqual(granted, [{ id: ID(2), scope: null, adds: ASK.adds }]);
  assert.deepEqual(requests.waitingFor(CHAT), []);
});

test("within it: waits for its owner, shown with its reason; Approve for this chat, once, and Deny reach the agent", async () => {
  const { requests, told, granted } = setup({ verdicts: { host: ASK } });
  await requests.received(event(1));
  await requests.received(event(2));
  await requests.received(event(3));
  const [shown] = requests.waitingFor(CHAT);
  assert.deepEqual(
    { ...shown, at: 0, expiresAt: 0 },
    {
      id: ID(1),
      kind: "host",
      what: "registry.npmjs.org",
      reason: "npm ci",
      live: true,
      state: "pending",
      message: null,
      at: 0,
      expiresAt: 0,
    },
  );
  assert.equal(shown.expiresAt - shown.at, 10 * 60_000);
  assert.deepEqual(told, []);

  // Someone else's chat, an unknown answer: nothing answered.
  assert.equal((await requests.answer("bob", "ffffffffffffffff", ID(1), "chat")).error, 404);
  assert.equal((await requests.answer("alice", CHAT, ID(1), "always")).error, 400);

  const chat = await requests.answer("alice", CHAT, ID(1), "chat");
  assert.equal(chat.request.state, "granted");
  const once = await requests.answer("Alice", CHAT, ID(2), "once");
  assert.equal(once.request.state, "granted");
  const deny = await requests.answer("alice", CHAT, ID(3), "deny");
  assert.equal(deny.request.state, "denied");
  await settled();
  assert.deepEqual(
    told.map((t) => [t.id, t.state, t.message]),
    [
      [ID(1), "granted", "Granted by alice for this chat: registry.npmjs.org. It applies now."],
      [ID(2), "granted", "Granted by alice once: registry.npmjs.org. It applies now."],
      [ID(3), "denied", "Denied by alice."],
    ],
  );
  assert.deepEqual(
    granted.map((g) => g.scope),
    ["chat", "once"],
  );
  // Answered: nothing left to show, and a second answer refused.
  assert.deepEqual(requests.waitingFor(CHAT), []);
  assert.equal((await requests.answer("alice", CHAT, ID(1), "deny")).error, 409);
});

test("an approval decided again: a grant removed meanwhile refuses it", async () => {
  const verdicts = { host: ASK };
  const { requests, told, granted } = setup({ verdicts });
  await requests.received(event(1));
  verdicts.host = { verdict: "beyond", message: "Refused: no longer granted." };
  const said = await requests.answer("alice", CHAT, ID(1), "chat");
  assert.equal(said.request.state, "refused");
  await settled();
  assert.deepEqual(granted, []);
  assert.equal(told[0].message, "Refused: no longer granted.");
});

test("CHAT_PERMISSION_TIMEOUT without an answer denies it", async () => {
  const { requests, told, clock } = setup({ verdicts: { host: ASK } });
  await requests.received(event(1));
  clock.advance(10 * 60_000 - 1);
  assert.deepEqual(told, []);
  clock.advance(1);
  await settled();
  await settled();
  assert.deepEqual(told, [
    { run: RUN, id: ID(1), state: "denied", message: "Denied: alice didn't answer within 10 min." },
  ]);
});

test("the run ending denies what it waits for; a request of a run gone, or not a chat's, is closed at once", async () => {
  const { requests, told, task, ctx } = setup({ verdicts: { host: ASK } });
  await requests.received(event(1));
  requests.ended(RUN);
  await settled();
  assert.deepEqual(told.at(-1), {
    run: RUN,
    id: ID(1),
    state: "denied",
    message: "Denied: this sandbox's run has ended.",
  });
  await requests.received({ ...event(2), run: "another-run" });
  await settled();
  assert.equal(told.at(-1).state, "denied");
  task.kind = "issue";
  ctx.chats.subjectOf = () => null;
  await requests.received(event(3));
  await settled();
  assert.deepEqual(told.at(-1), {
    run: RUN,
    id: ID(3),
    state: "refused",
    message: "Refused: this run may not ask for permissions.",
  });
});

test("an agent asking in parallel: past WAITING_MAX, refused until the others are answered", async () => {
  const { requests, told } = setup({ verdicts: { host: ASK } });
  for (const n of [1, 2, 3, 4]) await requests.received(event(n));
  await settled();
  assert.equal(requests.waitingFor(CHAT).length, 3);
  assert.deepEqual(
    told.map((t) => [t.id, t.state]),
    [[ID(4), "refused"]],
  );
});

test("WAITING_MAX counts the requests waiting, not those still being decided", async () => {
  const given = { verdict: "given", message: "Granted: this sandbox reads GitHub already." };
  let decided;
  const { requests, told } = setup({
    verdicts: { host: ASK, github: new Promise((resolve) => (decided = resolve)) },
  });
  // Three being decided (granted at once in the end), then three that wait: none refused.
  const deciding = [1, 2, 3].map((n) => requests.received(event(n, "github", { value: "read" })));
  for (const n of [4, 5, 6]) await requests.received(event(n));
  decided(given);
  await Promise.all(deciding);
  await settled();
  assert.equal(requests.waitingFor(CHAT).length, 3);
  assert.deepEqual(
    told.map((t) => t.state),
    ["granted", "granted", "granted"],
  );
});

test("a request read again from the stream isn't asked twice; one that can't be decided is refused", async () => {
  const { requests, told } = setup({
    verdicts: { host: ASK, engine: new Error("the policies are away") },
  });
  await requests.received(event(1));
  await requests.received(event(1));
  assert.equal(requests.waitingFor(CHAT).length, 1);
  await requests.received(event(2, "engine"));
  await settled();
  assert.equal(told[0].state, "refused");
  assert.match(told[0].message, /can't be decided now \(the policies are away\)/);
});

test("kept in the store: the next copy shows them, its timeout armed again; an answer the broker missed told again", async () => {
  const store = openStore("memory:");
  const first = setup({ store, verdicts: { host: ASK }, failing: true });
  await first.requests.received(event(1));
  await first.requests.received(event(2));
  await first.requests.answer("alice", CHAT, ID(2), "deny");
  await settled();
  first.requests.stop();
  assert.equal(Object.keys(await store.get(REQUESTS_KEY)).length, 2);

  const next = setup({ store, verdicts: { host: ASK } });
  await next.requests.load();
  next.requests.start();
  await settled();
  // Its answer, which the broker didn't take from the first copy.
  assert.deepEqual(
    next.told.map((t) => [t.id, t.state]),
    [[ID(2), "denied"]],
  );
  assert.equal(next.requests.waitingFor(CHAT).length, 1);
  next.clock.advance(10 * 60_000);
  await settled();
  await settled();
  assert.deepEqual(next.told.at(-1).state, "denied");
});

test("a reason: one line, redacted, cut to REASON_MAX", () => {
  const token = `ghp_${"a".repeat(36)}`;
  assert.equal(reasonLine(`npm ci\nneeds it, with ${token}`), "npm ci needs it, with [redacted]");
  const long = reasonLine("x".repeat(500));
  assert.equal(long.length, REASON_MAX);
  assert.ok(long.endsWith("…"));
  assert.equal(reasonLine("  <script>alert(1)</script>  "), "<script>alert(1)</script>");
});

test("an answer under way: its timeout waits for it, a second answer is refused, and the first answer stays", async () => {
  const verdicts = { host: ASK };
  const { requests, told, clock, granted } = setup({ verdicts });
  await requests.received(event(1));
  let decided;
  verdicts.host = new Promise((resolve) => (decided = resolve));
  const approving = requests.answer("alice", CHAT, ID(1), "chat");
  // The timeout passes while its approval is decided: it waits for the answer.
  clock.advance(10 * 60_000);
  assert.equal((await requests.answer("alice", CHAT, ID(1), "deny")).error, 409);
  decided(ASK);
  assert.equal((await approving).request.state, "granted");
  await settled();
  assert.deepEqual(
    told.map((t) => t.state),
    ["granted"],
  );
  assert.equal(granted.length, 1);
});

test("a run ending while its approval is decided: closed as denied, nothing granted", async () => {
  const verdicts = { host: ASK };
  const { requests, told, granted, task } = setup({ verdicts });
  await requests.received(event(1));
  let decided;
  verdicts.host = new Promise((resolve) => (decided = resolve));
  const approving = requests.answer("alice", CHAT, ID(1), "once");
  requests.ended(RUN);
  task.live.finishing = true;
  decided(ASK);
  assert.equal((await approving).error, 409);
  await settled();
  assert.deepEqual(
    told.map((t) => t.state),
    ["denied"],
  );
  assert.deepEqual(granted, []);
});

test("a run ending while its request is first decided: nothing armed, nothing asked", async () => {
  let decided;
  const { requests, told, clock, ctx } = setup({
    verdicts: { host: new Promise((resolve) => (decided = resolve)) },
  });
  const receiving = requests.received(event(1));
  // Being decided: not answerable yet.
  assert.equal((await requests.answer("alice", CHAT, ID(1), "chat")).error, 409);
  requests.ended(RUN);
  ctx.tasks.clear();
  decided(ASK);
  await receiving;
  await settled();
  assert.deepEqual(requests.waitingFor(CHAT), []);
  clock.advance(10 * 60_000);
  await settled();
  assert.deepEqual(
    told.map((t) => t.state),
    ["denied"],
  );
});

test("a run ending while an approval is saved: granted, as it was applied, and told so", async () => {
  const { requests, told, granted, task, ctx } = setup({ verdicts: { host: ASK } });
  await requests.received(event(1));
  let saved;
  ctx.saving = new Promise((resolve) => (saved = resolve));
  const approving = requests.answer("alice", CHAT, ID(1), "chat");
  await settled();
  assert.equal(granted.length, 1);
  task.live.finishing = true;
  requests.ended(RUN);
  saved();
  assert.equal((await approving).request.state, "granted");
  await settled();
  assert.deepEqual(
    told.map((t) => t.state),
    ["granted"],
  );
});

test("take(): kept and stored before its decision, which goes on apart; no card until it is decided", async () => {
  let decided;
  const store = openStore("memory:");
  const { requests, told } = setup({
    store,
    verdicts: { host: new Promise((resolve) => (decided = resolve)) },
  });
  await requests.take(event(1));
  // In the store already: a copy stopping now loses nothing.
  assert.equal((await store.get(REQUESTS_KEY))[ID(1)].state, "pending");
  assert.deepEqual(requests.waitingFor(CHAT), []);
  decided(ASK);
  await settled();
  await settled();
  assert.equal(requests.waitingFor(CHAT).length, 1);
  assert.deepEqual(told, []);
});

test("a request kept undecided by the copy before: decided by the next one, not asked as it was", async () => {
  const store = openStore("memory:");
  const first = setup({ store, verdicts: { host: new Promise(() => {}) } });
  await first.requests.take(event(1));
  first.requests.stop();
  const message =
    "Refused: evil.example isn't among the hosts the operator grants this repository.";
  const next = setup({ store, verdicts: { host: { verdict: "beyond", message } } });
  await next.requests.load();
  next.requests.start();
  await settled();
  await settled();
  assert.deepEqual(
    next.told.map((t) => [t.id, t.state]),
    [[ID(1), "refused"]],
  );
});

test("a request the store didn't take: forgotten, its event left to read again, then kept", async () => {
  const store = openStore("memory:");
  const set = store.set.bind(store);
  let failing = true;
  store.set = async (...args) => {
    if (failing) throw new Error("the store is away");
    return set(...args);
  };
  const { requests } = setup({ store, verdicts: { host: ASK } });
  await assert.rejects(requests.take(event(1)), /the store is away/);
  assert.equal(requests.get(ID(1)), null);
  failing = false;
  await requests.take(event(1));
  assert.equal((await store.get(REQUESTS_KEY))[ID(1)].state, "pending");
});

test("a machine run's tool call (#600): its input's lead field or JSON, one line, redacted, cut; fenced as text", () => {
  assert.equal(inputLine({ command: "make\n  level", description: "Build" }), "make level");
  assert.equal(inputLine({ file_path: "/w/Level.umap", content: "…" }), "/w/Level.umap");
  assert.equal(inputLine({ query: "unreal" }), '{"query":"unreal"}');
  const secret = `sk-ant-${"q".repeat(40)}`;
  const line = inputLine({ command: `curl -H 'x-api-key: ${secret}'` }, [secret]);
  assert.equal(line.includes(secret), false);
  assert.match(line, /^curl -H 'x-api-key: /);
  assert.equal(inputLine({ command: "x".repeat(500) }).length, REASON_MAX);
  assert.equal(fenced("Bash: ls"), "```text\nBash: ls\n```");
  // Longer than any run of backticks inside: none ends it.
  assert.equal(fenced("a ```` b ` c"), "`````text\na ```` b ` c\n`````");
});
