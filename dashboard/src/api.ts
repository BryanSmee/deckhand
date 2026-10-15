// The listener's API: api/state polled, a run's log streamed (server-sent events), the
// repositories listed, onboarded and their config read, the graph's backlog and its actions,
// answers to open questions.
// Relative URLs, like the assets: the page works under any path.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Pending } from "./graph";
import type {
  Answers,
  Backlog,
  Entry,
  Onboarded,
  Repo,
  RepoConfig,
  Repos,
  State,
  WorkAction,
  WorkResult,
} from "./types";

const POLL_MS = 3000;

export interface AppState {
  state: State | null;
  error: string | null;
  // Read it now (after an action), not at the next tick.
  refresh: () => Promise<void>;
}

export function useAppState(): AppState {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Each read's number, and the last one shown: a slow answer read before another one that
  // came back already is older, and dropped.
  const asked = useRef(0);
  const shown = useRef(0);
  const stopped = useRef(false);
  const refresh = async () => {
    const mine = ++asked.current;
    try {
      const res = await fetch("api/state", { cache: "no-store" });
      // Signed out (or no longer an allowed user): the sign-in page.
      if (res.status === 401) return location.reload();
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as State;
      if (stopped.current || mine < shown.current) return;
      shown.current = mine;
      setState(next);
      setError(null);
    } catch (e) {
      if (!stopped.current && mine >= shown.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };
  useEffect(() => {
    stopped.current = false;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      stopped.current = true;
      clearInterval(timer);
    };
  }, []);
  return { state, error, refresh };
}

// A run's log so far, then live until it ends.
export function useRunLog(runId: string | null): { entries: Entry[]; ended: boolean } {
  const [log, setLog] = useState<{ id: string | null; entries: Entry[]; ended: boolean }>({
    id: null,
    entries: [],
    ended: false,
  });
  useEffect(() => {
    setLog({ id: runId, entries: [], ended: false });
    if (!runId) return;
    const source = new EventSource(`api/runs/${encodeURIComponent(runId)}/stream`);
    source.addEventListener("entries", (event) => {
      const more = JSON.parse((event as MessageEvent).data) as Entry[];
      setLog((l) => (l.id === runId ? { ...l, entries: [...l.entries, ...more] } : l));
    });
    source.addEventListener("end", () => {
      source.close();
      setLog((l) => (l.id === runId ? { ...l, ended: true } : l));
    });
    return () => source.close();
  }, [runId]);
  return log.id === runId ? log : { entries: [], ended: false };
}

// The listener caches the list for minutes: polling it now and then costs GitHub nothing.
const REPOS_POLL_MS = 60000;

export interface RepoList {
  repos: Repo[] | null;
  // When the listener last listed the installations' repositories.
  listedAt: number | null;
  error: string | null;
  // The repo whose onboarding is being started, and the last failure to.
  starting: string | null;
  failed: { repo: string; error: string } | null;
  onboard: (repo: string) => Promise<void>;
  // The tab's Refresh: everything read again from GitHub.
  refreshing: boolean;
  refreshError: string | null;
  refresh: () => Promise<void>;
  // A row read again elsewhere (the config panel).
  update: (row: Repo) => void;
}

// A JSON answer, or { error } from its status.
async function answer<T>(res: Response): Promise<T & { error?: string }> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && !body.error) body.error = String(res.status);
  return body;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useRepos(): RepoList {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [listedAt, setListedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [failed, setFailed] = useState<RepoList["failed"]>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const show = (next: Repos) => {
    setRepos(next.repos);
    setListedAt(next.listedAt ?? null);
    setError(null);
  };
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch("api/repos", { cache: "no-store" });
        if (res.status === 401) return location.reload();
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as Repos;
        if (!stopped) show(next);
      } catch (e) {
        if (!stopped) setError(message(e));
      }
    };
    poll();
    const timer = setInterval(poll, REPOS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const update = (row: Repo) =>
    setRepos((all) => all && all.map((r) => (r.repo === row.repo ? row : r)));

  const onboard = async (repo: string) => {
    setStarting(repo);
    setFailed(null);
    try {
      const res = await fetch(`api/repos/${repo}/onboard`, { method: "POST" });
      const body = await answer<Onboarded>(res);
      if (body.repo) update(body.repo);
      if (body.error) setFailed({ repo, error: body.error });
    } catch (e) {
      setFailed({ repo, error: message(e) });
    } finally {
      setStarting(null);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const body = await answer<Repos>(await fetch("api/repos/refresh", { method: "POST" }));
      if (body.error) setRefreshError(body.error);
      else show(body);
    } catch (e) {
      setRefreshError(message(e));
    } finally {
      setRefreshing(false);
    }
  };

  return {
    repos,
    listedAt,
    error,
    starting,
    failed,
    onboard,
    refreshing,
    refreshError,
    refresh,
    update,
  };
}

export interface RepoConfigView {
  config: RepoConfig | null;
  // Reading it failed: the first read, or a refresh (the last config stays shown).
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

// One repo's config, read from GitHub when the panel opens and on its Refresh. `onRow`: its
// row, read along with it.
export function useRepoConfig(repo: string, onRow: (row: Repo) => void): RepoConfigView {
  const [config, setConfig] = useState<RepoConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The repo open now: an answer for another one (opened before) is dropped.
  const current = useRef(repo);
  current.current = repo;
  const load = async (init?: RequestInit) => {
    setLoading(true);
    setError(null);
    const mine = () => current.current === repo;
    try {
      const url = `api/repos/${repo}/${init ? "refresh" : "config"}`;
      const res = await fetch(url, { cache: "no-store", ...init });
      if (res.status === 401) return location.reload();
      const body = await answer<RepoConfig>(res);
      if (!mine()) return;
      if (body.error) return setError(body.error);
      setConfig(body);
      onRow(body.repo);
    } catch (e) {
      if (mine()) setError(message(e));
    } finally {
      if (mine()) setLoading(false);
    }
  };
  useEffect(() => {
    setConfig(null);
    load();
  }, [repo]);
  return { config, error, loading, refresh: () => load({ method: "POST" }) };
}

// The listener reads GitHub at most every 30 seconds for it: polling costs nothing more.
const BACKLOG_POLL_MS = 30000;

export interface WorkArea {
  backlog: Backlog | null;
  error: string | null;
  // An action on its way (the graph draws them at once), and what the last one said.
  busy: boolean;
  pending: Pending[];
  result: WorkResult | null;
  act: (action: WorkAction) => Promise<void>;
}

// One repo's backlog and the actions on its issues; nothing on the All tab (`repo` null).
// `refresh`: reads api/state again, once an action is done.
export function useWorkArea(
  repo: string | null,
  refresh: () => Promise<void> = async () => {},
): WorkArea {
  const [backlog, setBacklog] = useState<Backlog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [result, setResult] = useState<WorkResult | null>(null);
  const current = useRef(repo);
  current.current = repo;
  const load = async () => {
    if (!repo) return;
    try {
      const res = await fetch(`api/repos/${repo}/issues`, { cache: "no-store" });
      if (res.status === 401) return location.reload();
      const body = await answer<Backlog>(res);
      if (current.current !== repo) return;
      if (body.error) return setError(body.error);
      setBacklog(body);
      setError(null);
    } catch (e) {
      if (current.current === repo) setError(message(e));
    }
  };
  useEffect(() => {
    setBacklog(null);
    setError(null);
    setResult(null);
    if (!repo) return;
    load();
    const timer = setInterval(load, BACKLOG_POLL_MS);
    return () => clearInterval(timer);
  }, [repo]);

  const act = async (action: WorkAction) => {
    if (!repo) return;
    const title = backlog?.issues.find((i) => i.number === action.number)?.title ?? null;
    const mine: Pending = { ...action, repo, title };
    setPending((all) => [...all, mine]);
    setResult(null);
    let done = false;
    try {
      const res = await fetch(`api/repos/${repo}/work`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      });
      const body = await answer<WorkResult>(res);
      setResult(body);
      done = !body.error;
    } catch (e) {
      setResult({ error: message(e) });
    }
    // The real node replaces the pending one, and the issue leaves the backlog for good:
    // both read again before it goes. A refusal just takes it away.
    if (done) await Promise.all([refresh(), load()]);
    setPending((all) => all.filter((p) => p !== mine));
  };

  const mine = pending.filter((p) => p.repo === repo);
  return { backlog, error, busy: mine.length > 0, pending: mine, result, act };
}

// Answers to a task's open questions: what the listener says, or why it refused.
export async function sendAnswers(repo: string, answers: Answers): Promise<WorkResult> {
  try {
    const res = await fetch(`api/repos/${repo}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(answers),
    });
    return await answer<WorkResult>(res);
  } catch (e) {
    return { error: message(e) };
  }
}
