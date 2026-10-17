// The listener's API: api/state polled, a run's log streamed (server-sent events), the
// repositories listed, onboarded and their config read, the graph's backlog and its actions,
// answers to open questions, a failed run again or a run stopped, feedback and discussions,
// run analyses.
// Relative URLs, like the assets: the page works under any path.
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  AnalysisPreview,
  AnalysisResult,
  AnalysisSelection,
  Answers,
  AnswersThen,
  Backlog,
  CancelAction,
  DiscussionComment,
  DiscussionResult,
  DiscussionStart,
  Entry,
  InboxEntry,
  InboxResult,
  Onboarded,
  Pending,
  Repo,
  RepoConfig,
  Repos,
  State,
  Thread,
  WorkAction,
  WorkResult,
} from "./types";

// What the listener answers, or why it refused: its `error`, else the status.
export type Answer<T> = T & { error?: string };

// A JSON answer, or { error } from its status. Signed out (or no longer an allowed user): the
// sign-in page, and the answer never comes.
async function answer<T>(res: Response): Promise<Answer<T>> {
  if (res.status === 401) {
    location.reload();
    return new Promise(() => {});
  }
  const body = (await res.json().catch(() => ({}))) as Answer<T>;
  if (!res.ok && !body.error) body.error = String(res.status);
  return body;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Reads a JSON answer, never from the browser's cache: what the listener says, or why not.
export async function getJson<T>(url: string): Promise<Answer<T>> {
  try {
    return await answer<T>(await fetch(url, { cache: "no-store" }));
  } catch (e) {
    return { error: message(e) } as Answer<T>;
  }
}

// POSTs a JSON body (none: an empty POST): what the listener says, or why it refused.
export async function postJson<T>(url: string, body?: unknown): Promise<Answer<T>> {
  try {
    const init: RequestInit =
      body === undefined
        ? { method: "POST" }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          };
    return await answer<T>(await fetch(url, init));
  } catch (e) {
    return { error: message(e) } as Answer<T>;
  }
}

export interface Polled<T> {
  // The last answer read; null until the first.
  data: T | null;
  // Why the last read failed (the last answer stays shown).
  error: string | null;
  // Read it now: after an action, not at the next tick.
  reload: () => Promise<void>;
  // An answer read another way (a POST that returns it), shown as the latest; or a change to
  // the one shown.
  show: (data: T | ((last: T | null) => T | null)) => void;
}

// `url` read now and every `ms` (null: once) while it stays the same; null: nothing to read.
// An answer for another url, or older than one shown already (a slow read before a quick
// one), is dropped. `onData`: each answer shown; `cached`: what to show for a url until its
// first answer.
export function usePolled<T>(
  url: string | null,
  ms: number | null,
  {
    onData,
    cached = () => null,
  }: { onData?: (data: T) => void; cached?: (url: string) => T | null } = {},
): Polled<T> {
  const [read, setRead] = useState(() => ({
    url,
    data: url ? cached(url) : null,
    error: null as string | null,
  }));
  // Each read's number, and the last one shown.
  const asked = useRef(0);
  const shown = useRef(0);
  const current = useRef(url);
  current.current = url;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const show = (data: T | ((last: T | null) => T | null)) => {
    if (typeof data === "function") {
      const change = data as (last: T | null) => T | null;
      return setRead((r) => ({ ...r, data: change(r.data) }));
    }
    // Newer than any read on its way.
    shown.current = ++asked.current;
    setRead({ url, data, error: null });
  };
  const reload = async () => {
    if (!url) return;
    const mine = ++asked.current;
    const body = await getJson<T>(url);
    if (!mounted.current || current.current !== url || mine < shown.current) return;
    if (body.error) return setRead((r) => ({ ...r, url, error: body.error! }));
    shown.current = mine;
    setRead({ url, data: body, error: null });
    onData?.(body);
  };
  useEffect(() => {
    setRead((r) => (r.url === url ? r : { url, data: url ? cached(url) : null, error: null }));
    if (!url) return;
    reload();
    if (ms === null) return;
    const timer = setInterval(reload, ms);
    return () => clearInterval(timer);
  }, [url]);
  return { data: read.data, error: read.error, reload, show };
}

const POLL_MS = 3000;

export interface AppState {
  state: State | null;
  error: string | null;
  // Read it now (after an action), not at the next tick.
  refresh: () => Promise<void>;
}

export function useAppState(): AppState {
  const { data, error, reload } = usePolled<State>("api/state", POLL_MS);
  return { state: data, error, refresh: reload };
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

export function useRepos(): RepoList {
  const list = usePolled<Repos>("api/repos", REPOS_POLL_MS);
  const [starting, setStarting] = useState<string | null>(null);
  const [failed, setFailed] = useState<RepoList["failed"]>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const update = (row: Repo) =>
    list.show(
      (last) => last && { ...last, repos: last.repos.map((r) => (r.repo === row.repo ? row : r)) },
    );

  const onboard = async (repo: string) => {
    setStarting(repo);
    setFailed(null);
    const body = await postJson<Onboarded>(`api/repos/${repo}/onboard`);
    if (body.repo) update(body.repo);
    if (body.error) setFailed({ repo, error: body.error });
    setStarting(null);
  };

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    const body = await postJson<Repos>("api/repos/refresh");
    if (body.error) setRefreshError(body.error);
    else list.show(body);
    setRefreshing(false);
  };

  return {
    repos: list.data?.repos ?? null,
    listedAt: list.data?.listedAt ?? null,
    error: list.error,
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
  const read = usePolled<RepoConfig>(`api/repos/${repo}/config`, null, {
    onData: (config) => onRow(config.repo),
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // The repo open now: an answer for another one (opened before) is dropped.
  const current = useRef(repo);
  current.current = repo;
  useEffect(() => setRefreshError(null), [repo]);
  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    const body = await postJson<RepoConfig>(`api/repos/${repo}/refresh`);
    setRefreshing(false);
    if (current.current !== repo) return;
    if (body.error) return setRefreshError(body.error);
    read.show(body);
    onRow(body.repo);
  };
  const error = refreshError ?? read.error;
  return {
    config: read.data,
    error,
    loading: refreshing || (!read.data && !error),
    refresh,
  };
}

// The listener reads GitHub at most every 30 seconds for it: polling costs nothing more.
const BACKLOG_POLL_MS = 30000;
// An old read (`refreshing`): the listener's new one lands in a moment, read again then rather
// than at the next poll.
const BACKLOG_AGAIN_MS = 2000;

// Each repo's last backlog, for as long as the page is open: leaving the Graph or a repo's
// tab and coming back shows it at once, while it is read again. Memory only: a reload waits
// for one read, and no issue title stays in the browser's storage.
const backlogs = new Map<string, Backlog>();

// For the tests: each starts with nothing seen.
export function forgetBacklogs() {
  backlogs.clear();
}

export interface WorkAreaState {
  backlog: Backlog | null;
  error: string | null;
  // An action on its way (the graph draws them at once), and what the last one said.
  busy: boolean;
  pending: Pending[];
  result: WorkResult | null;
  // `answers`: the issue's open questions answered, sent along (api/repos/<repo>/answer).
  act: (action: WorkAction, answers?: Answers) => Promise<WorkResult>;
}

// One repo's backlog and the actions on its issues; nothing on the All tab (`repo` null).
// `refresh`: reads api/state again, once an action is done.
export function useWorkArea(
  repo: string | null,
  refresh: () => Promise<void> = async () => {},
): WorkAreaState {
  const again = useRef<ReturnType<typeof setTimeout>>();
  const read = usePolled<Backlog>(repo && `api/repos/${repo}/issues`, BACKLOG_POLL_MS, {
    onData: (backlog) => {
      if (!repo) return;
      backlogs.set(repo, backlog);
      // Once per answer: a later one replaces it.
      clearTimeout(again.current);
      if (backlog.refreshing) again.current = setTimeout(() => read.reload(), BACKLOG_AGAIN_MS);
    },
    cached: () => (repo ? (backlogs.get(repo) ?? null) : null),
  });
  useEffect(() => () => clearTimeout(again.current), [repo]);
  const backlog = read.data;
  const [pending, setPending] = useState<Pending[]>([]);
  const [result, setResult] = useState<WorkResult | null>(null);
  useEffect(() => setResult(null), [repo]);

  const act = async (action: WorkAction, answers?: Answers): Promise<WorkResult> => {
    if (!repo) return { error: "No repository." };
    const title = backlog?.issues.find((i) => i.number === action.number)?.title ?? null;
    const mine: Pending = { ...action, repo, title };
    setPending((all) => [...all, mine]);
    setResult(null);
    let said: WorkResult;
    if (answers) {
      const { number: _, ...then } = action;
      said = await sendAnswers(repo, { ...answers, then: then as AnswersThen });
    } else {
      said = await postJson<WorkResult>(`api/repos/${repo}/work`, action);
    }
    setResult(said);
    const done = !said.error;
    // The real node replaces the pending one, and the issue leaves the backlog for good:
    // both read again before it goes. A refusal just takes it away.
    if (done) await Promise.all([refresh(), read.reload()]);
    setPending((all) => all.filter((p) => p !== mine));
    return said;
  };

  const mine = pending.filter((p) => p.repo === repo);
  return {
    backlog,
    error: read.error,
    busy: mine.length > 0,
    pending: mine,
    result,
    act,
  };
}

// Answers to a task's open questions: what the listener says, or why it refused.
export const sendAnswers = (repo: string, answers: Answers) =>
  postJson<WorkResult>(`api/repos/${repo}/answer`, answers);

// A task's last run again, when it failed (api/repos/<repo>/rerun): what the listener says,
// or why it refused.
export const sendRerun = (repo: string, runId: string) =>
  postJson<WorkResult>(`api/repos/${repo}/rerun`, { runId });

// Stops the task's run (api/repos/<repo>/work, `cancel`): what the listener says, or why it
// refused. `pr`: a pull request's task.
export function sendCancel(repo: string, number: number, pr: boolean): Promise<WorkResult> {
  const body: CancelAction = { action: "cancel", number, pr };
  return postJson<WorkResult>(`api/repos/${repo}/work`, body);
}

// An idea or a bug report for the repo's inbox (api/repos/<repo>/inbox): the comment it
// became and the inbox's task, or why it was refused.
export const sendToInbox = (repo: string, entry: InboxEntry) =>
  postJson<InboxResult>(`api/repos/${repo}/inbox`, entry);

// What an analysis of these runs would read (api/repos/<repo>/analyze), or why it can't.
export function previewAnalysis(
  repo: string,
  { count, kinds, outcomes }: AnalysisSelection,
): Promise<AnalysisPreview> {
  const query = new URLSearchParams({
    count: String(count),
    kinds: kinds.join(","),
    outcomes: outcomes.join(","),
  });
  return getJson<AnalysisPreview>(`api/repos/${repo}/analyze?${query}`);
}

// A run analysis: its new issue and task, or why it was refused.
export const startAnalysis = (repo: string, selection: AnalysisSelection) =>
  postJson<AnalysisResult>(`api/repos/${repo}/analyze`, selection);

// A discussion in the repo's discussions category (api/repos/<repo>/discussions): the
// discussion it became and its task, or why it was refused.
export const startDiscussion = (repo: string, start: DiscussionStart) =>
  postJson<DiscussionResult>(`api/repos/${repo}/discussions`, start);

// A comment in discussion `number`, in a thread when `replyTo` says which.
export const sendDiscussionComment = (repo: string, number: number, comment: DiscussionComment) =>
  postJson<WorkResult>(`api/repos/${repo}/discussions/${number}/comments`, comment);

// The listener reads GitHub at most every 15 seconds for it.
const THREAD_POLL_MS = 15000;

export interface ThreadView {
  thread: Thread | null;
  error: string | null;
  // Read it now (a comment sent).
  reload: () => Promise<void>;
}

// A discussion's thread while it is shown, read again now and then: comments written on
// GitHub show up too.
export function useThread(repo: string, number: number): ThreadView {
  const { data, error, reload } = usePolled<Thread>(
    `api/repos/${repo}/discussions/${number}`,
    THREAD_POLL_MS,
  );
  return { thread: data, error, reload };
}
