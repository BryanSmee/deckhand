// What the specs share: a fake listener behind `fetch`, the fixture's state and tasks built
// from it, a DataTransfer and an empty backlog. Imported by specs only, so never bundled; not
// named test-*.ts, which `node --test` would run.
import { fireEvent, screen, within } from "@testing-library/preact";
import { vi } from "vitest";
import fixture from "./fixture.json";
import type {
  Backlog,
  Capabilities,
  CapabilityInfo,
  Chat,
  Chats,
  ModeCapabilities,
  PlanUsage,
  PolicyFile,
  Run,
  State,
  Task,
} from "./types";

// A request the dashboard made: its JSON body parsed (undefined for a GET or an empty POST).
// `any`: each handler knows the body it gets.
export type Call = { url: string; method: string; body: any };
export type Posted = Omit<Call, "method">;
// What a route answers: a Response as it is, anything else as its JSON.
export type Handler = (call: Call) => unknown;

// Stubs `fetch` with `routes`: "path" for a GET (the query left out, the handler has the whole
// url), "POST path" for a POST. Another GET is a 404; another POST gets `answer()`. POSTs are
// kept in `posted`, in order, and wait while held (`hold()`): what shows on their way.
export function mockApi(routes: Record<string, Handler> = {}) {
  let gate: Promise<void> | null = null;
  const api = {
    routes,
    posted: [] as Posted[],
    answer: ((): unknown => ({ message: "done" })) as Handler,
    bodies: () => api.posted.map((p) => p.body),
    // Holds the POSTs from now until the returned function lets them go.
    hold() {
      let release = () => {};
      gate = new Promise((resolve) => (release = resolve));
      return () => {
        gate = null;
        release();
      };
    },
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const call = { url, method, body };
    const path = url.split("?")[0];
    const route = api.routes[method === "GET" ? path : `${method} ${path}`];
    if (method !== "GET") {
      api.posted.push({ url, body });
      await gate;
    } else if (!route) return new Response("{}", { status: 404 });
    const answer = await (route ?? api.answer)(call);
    return answer instanceof Response ? answer : Response.json(answer);
  });
  return api;
}

// The fixture's api/state with `partial` over it, and `added` tasks after its own.
export const makeState = (partial: Partial<State> = {}, added: Task[] = []): State => {
  const state = { ...(fixture as State), ...partial };
  return { ...state, tasks: [...state.tasks, ...added] };
};

// A plan's usage as api/state gives it: Claude's, its 5-hour window 42 % used and its week 18 %,
// read at `now`, resetting after it.
export const makePlan = (partial: Partial<PlanUsage> = {}, now = 1_800_000_000_000): PlanUsage => ({
  plan: "claude",
  label: "Claude",
  windows: [
    { name: "5h", used: 0.42, resetsAt: now + 3_600_000, at: now },
    { name: "7d", used: 0.18, resetsAt: now + 3 * 86_400_000, at: now },
  ],
  updatedAt: now,
  limited: false,
  limitedUntil: null,
  ...partial,
});

// A task as board.mjs lists it: an open issue of acme/app at work, with no run yet.
export const makeTask = (partial: Partial<Task> = {}): Task => {
  const repo = partial.repo ?? "acme/app";
  const number = partial.number ?? 1;
  return {
    key: `${repo}#${number}`,
    repo,
    project: "acme",
    number,
    title: `Issue ${number}`,
    kind: "issue",
    mode: null,
    replyTo: number,
    state: "working",
    since: 0,
    updatedAt: 0,
    closed: null,
    pr: null,
    rerunnable: false,
    dismissed: null,
    runs: [],
    ...partial,
  };
};

// A task's `n` runs, newest first: run k (1 = the oldest) started k hours after `start` and took
// 10 min, the newest still going; every other one a review fix.
export const makeRuns = (key: string, n: number, start = 0): Run[] =>
  Array.from({ length: n }, (_, i) => {
    const k = n - i;
    const startedAt = start + k * 3_600_000;
    return {
      id: `${key.replace(/\W+/g, "-")}-${k}`,
      key,
      kind: "issue",
      title: null,
      repo: key.split("#")[0],
      replyTo: null,
      mode: k === 1 ? "start" : "continue",
      taskMode: "work",
      reason: k % 2 ? null : "review-fix",
      startedAt,
      finishedAt: i === 0 ? null : startedAt + 600_000,
      status: i === 0 ? "running" : "ok",
    } satisfies Run;
  });

// A chat as listener/chats.mjs view() gives it: alice's, on acme/app, stopped, with no run.
export const makeChat = (partial: Partial<Chat> = {}): Chat => ({
  id: "0123456789abcdef",
  owner: "alice",
  repo: "acme/app",
  base: "main",
  agent: null,
  model: null,
  effort: null,
  title: "What does run() do?",
  createdAt: 0,
  lastActiveAt: 0,
  resetAt: null,
  status: "stopped",
  queued: false,
  reachable: true,
  pending: [],
  requests: [],
  runs: [],
  ...partial,
});

// GET api/chats: `chats`, of 4 at most, on acme/app or acme/api, with Claude to pick.
export const makeChats = (chats: Chat[] = [], partial: Partial<Chats> = {}): Chats => ({
  chats,
  limit: 4,
  repos: ["acme/api", "acme/app"],
  agents: [{ name: "claude@anthropic", label: "Claude (anthropic)" }],
  models: ["best", "balanced", "fast"],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  ...partial,
});

// Runs going on, newest first, with only what the dialogs' links read.
export const running = (ids: string[]) =>
  ids.map((id) => ({ id, status: "running", startedAt: 0 })) as unknown as Run[];

// The browser's DataTransfer, which jsdom doesn't have.
export function transfer(data: Record<string, string> = {}) {
  return {
    data,
    get types() {
      return Object.keys(data);
    },
    setData(type: string, value: string) {
      data[type] = value;
    },
    getData: (type: string) => data[type] ?? "",
    effectAllowed: "none",
    dropEffect: "none",
    // The drag image set, if one was: a card's hides the browser's.
    image: null as Element | null,
    setDragImage(image: Element) {
      this.image = image;
    },
  };
}

// A repo's backlog with no issue, every mode on.
export const BACKLOG: Backlog = {
  issues: [],
  modes: ["work", "brainstorm", "review"],
  errors: false,
  readAt: 0,
  refreshing: false,
};

// A policy file of a repo's config: an active repo file with no rule, unless `over` says.
export function makePolicyFile(over: Partial<PolicyFile> & Pick<PolicyFile, "name">): PolicyFile {
  return {
    source: "repo",
    replaces: null,
    active: true,
    rules: [],
    url: null,
    text: "package deckhand\n",
    truncated: false,
    ...over,
  };
}

// The catalogue, as listener/capabilities.mjs catalogueView() sends it.
export const CATALOGUE: CapabilityInfo[] = [
  ["pull", "a clone of the repository: its code and history", [], [], null],
  ["push", "its branches pushed, its issue's branch and draft pull request", ["pull"], [], null],
  ["setup", "the repository's setup command, and its caches", ["pull"], ["setup", "caches"], null],
  [
    "image:repo",
    "the image built from the repository's Dockerfile",
    ["pull"],
    ["dockerfile"],
    "dockerfile",
  ],
  ["docker", "a container engine next to the sandbox", ["pull"], ["docker"], "docker"],
  ["internet", "any public host, beyond the hosts the operator grants", [], [], "research"],
  ["read:issues", "the repository's issues", [], [], null],
].map(([name, what, needs, config, grant]) => ({
  name: name as string,
  what: what as string,
  needs: needs as string[],
  config: config as string[],
  grant: grant as string | null,
  enforcedBy: "the listener at start",
}));

// A mode's runs on the config page: each capability of CATALOGUE used when `used` names it,
// else not allowed, unless `over` says.
export function makeModeCapabilities(
  over: Partial<ModeCapabilities> & Pick<ModeCapabilities, "mode">,
  used: string[] = [],
): ModeCapabilities {
  return {
    custom: false,
    capabilities: CATALOGUE.map(({ name }) =>
      used.includes(name)
        ? {
            name,
            status: "used",
            used: true,
            files: [{ layer: "operator", file: `mode-${over.mode}.rego` }],
            reason: null,
          }
        : {
            name,
            status: "not-allowed",
            used: false,
            files: [],
            reason: "no allow rule of the operator's policies gives it",
          },
    ),
    used,
    errors: [],
    warnings: [],
    ...over,
  };
}

// A repo's capabilities on its config page: work's and a brainstorm's, unless `over` says.
export function makeCapabilities(over: Partial<Capabilities> = {}): Capabilities {
  return {
    catalogue: CATALOGUE,
    modes: [
      makeModeCapabilities({ mode: "work" }, ["pull", "push", "setup", "read:issues"]),
      makeModeCapabilities({ mode: "brainstorm" }, ["pull", "read:issues"]),
    ],
    error: null,
    ...over,
  };
}

// A log stream (api.ts useRunLog()): the last one opened, which a spec makes speak. `emit()`'s
// id is the event's, kept for the next ones as a browser's lastEventId is; `open()`, the
// connection (re)opening.
export class FakeSource {
  static last: FakeSource | null = null;
  // Every one opened since the spec cleared it: a chat streams each of its runs' logs.
  static opened: FakeSource[] = [];
  listeners = new Map<string, ((e: { data: string; lastEventId: string }) => void)[]>();
  closed = false;
  lastEventId = "";
  constructor(public url: string) {
    FakeSource.last = this;
    FakeSource.opened.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string; lastEventId: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown, id?: number) {
    if (id !== undefined) this.lastEventId = String(id);
    const event = { data: JSON.stringify(data), lastEventId: this.lastEventId };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  open() {
    for (const fn of this.listeners.get("open") ?? []) fn({ data: "", lastEventId: "" });
  }
}

// "Queue #<number> after…" open: filters the board's issues by `after`'s number, then queues.
export function queueAfter(number: number, after: number) {
  const dialog = screen.getByRole("dialog", { name: `Queue #${number} after…` });
  fireEvent.input(within(dialog).getByRole("combobox", { name: "Filter issues" }), {
    target: { value: String(after) },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: `Queue after #${after}` }));
}
