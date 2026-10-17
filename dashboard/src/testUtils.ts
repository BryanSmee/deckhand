// What the specs share: a fake listener behind `fetch`, the fixture's state and tasks built
// from it, a DataTransfer and an empty backlog. Imported by specs only, so never bundled; not
// named test-*.ts, which `node --test` would run.
import { vi } from "vitest";
import fixture from "./fixture.json";
import type { Backlog, Run, State, Task } from "./types";

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
    closed: null,
    pr: null,
    rerunnable: false,
    runs: [],
    ...partial,
  };
};

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
  };
}

// A repo's backlog with no issue, every mode on.
export const BACKLOG: Backlog = {
  issues: [],
  modes: ["work", "brainstorm", "review"],
  errors: false,
  readAt: 0,
};
