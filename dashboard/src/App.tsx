// The dashboard: repo tabs, the tab's tasks filtered by state, the open task and its log; the
// graph of what waits for what; or the repositories page, where onboarding starts and each
// one's config shows.
// What is shown lives in the address (route.ts); the state chip and the graph's "Show closed"
// are kept on this device.
import { useEffect, useState } from "preact/hooks";
import { type RepoList, useAppState, useRepos } from "./api";
import { Detail } from "./Detail";
import { Graph } from "./Graph";
import { type ChipId, CHIPS, inChip, isLive } from "./format";
import { useReadyNotifications } from "./notify";
import { notOnboarded, Repos } from "./Repos";
import { formatRoute, parseRoute, type Route } from "./route";
import { Tabs } from "./Tabs";
import { TaskList } from "./TaskList";
import type { State } from "./types";
import styles from "./App.module.css";

export function App() {
  const { state, error, refresh } = useAppState();
  const repos = useRepos();
  return <Dashboard state={state} error={error} repos={repos} refresh={refresh} />;
}

const stored = (name: string) => {
  try {
    return localStorage.getItem(`deckhand.${name}`);
  } catch {
    return null;
  }
};
const store = (name: string, value: string) => {
  try {
    localStorage.setItem(`deckhand.${name}`, value);
  } catch {
    // Private mode: not kept.
  }
};

// No address yet: the tab last open on this device.
function readRoute(): Route {
  if (location.hash.length > 1) return parseRoute(location.hash);
  const repo = stored("tab");
  return { repo: repo || null, task: null, run: null };
}

function useRoute(): [Route, (next: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    addEventListener("hashchange", onChange);
    addEventListener("popstate", onChange);
    return () => {
      removeEventListener("hashchange", onChange);
      removeEventListener("popstate", onChange);
    };
  }, []);
  const go = (next: Route, replace = false) => {
    const hash = formatRoute(next);
    if (replace) history.replaceState(null, "", hash);
    else history.pushState(null, "", hash);
    setRoute(next);
  };
  return [route, go];
}

function useWide() {
  const query = "(min-width: 761px)";
  const [wide, setWide] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const onChange = () => setWide(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);
  return wide;
}

interface Props {
  state: State | null;
  error: string | null;
  repos?: RepoList;
  // Reads api/state again: after a work area action.
  refresh?: () => Promise<void>;
}

export function Dashboard({ state, error, repos, refresh }: Props) {
  const [route, go] = useRoute();
  const [chip, setChip] = useState<ChipId>(() => {
    const saved = stored("chip");
    return CHIPS.some((c) => c.id === saved) ? (saved as ChipId) : "all";
  });
  const [showClosed, setShowClosed] = useState(() => stored("graphClosed") === "1");
  const wide = useWide();
  const tasks = state?.tasks ?? [];
  const now = state?.now ?? Date.now();
  const inTab = route.repo ? tasks.filter((t) => t.repo === route.repo) : tasks;

  const task = (route.task && tasks.find((t) => t.key === route.task)) || null;
  const run = (task && route.run && task.runs.find((r) => r.id === route.run)) || task?.runs[0];
  // A wide screen has room for a task: the first live one, else the first one, once.
  const visible = inTab.filter((t) => inChip(chip, t));
  const first = visible.find(isLive) ?? visible[0];
  const onRepos = route.page === "repositories";
  const onGraph = route.page === "graph";
  useEffect(() => {
    if (wide && !route.page && !route.task && first)
      go({ ...route, task: first.key, run: null }, true);
  }, [wide, route.page, route.task, first?.key]);

  const selectTab = (repo: string | null) => {
    store("tab", repo ?? "");
    go({ repo, task: null, run: null });
  };
  const selectShowClosed = (show: boolean) => {
    store("graphClosed", show ? "1" : "");
    setShowClosed(show);
  };
  const selectChip = (next: ChipId) => {
    store("chip", next);
    setChip(next);
  };

  const hooks = state?.previews?.length ?? 0;
  const status = error
    ? `Can't reach the listener (${error})`
    : state
      ? `${state.running} running (max ${state.maxParallel}) · ${state.queued} queued` +
        (hooks ? ` · ${hooks} preview hook${hooks > 1 ? "s" : ""}` : "")
      : "Loading…";
  const waiting = notOnboarded(repos?.repos ?? null);
  const notify = useReadyNotifications(state);

  return (
    <div class={`${styles.app} ${task ? styles.reading : ""}`}>
      <header class={styles.top}>
        <h1 class={styles.brand}>Deckhand</h1>
        <span class={`${styles.status} ${error ? styles.error : ""}`}>{status}</span>
        <nav class={styles.pages} aria-label="Pages">
          <a
            class={styles.link}
            href={formatRoute({ repo: route.repo, task: null, run: null, page: "graph" })}
            aria-current={onGraph ? "page" : undefined}
            title="What waits for what"
          >
            Graph
          </a>
          {repos && (
            <a
              class={styles.link}
              href="#/repositories"
              aria-current={onRepos ? "page" : undefined}
              title={waiting ? `${waiting} not onboarded` : "Repositories"}
            >
              Repositories
              {waiting > 0 && <span class={styles.waiting}>{waiting}</span>}
            </a>
          )}
        </nav>
        {notify.permission === "default" && (
          <button
            type="button"
            class={styles.notify}
            title="A browser notification when a pull request is ready for review, while this page is open"
            onClick={notify.ask}
          >
            Notify me
          </button>
        )}
        {state && (
          <form class={styles.who} method="post" action="auth/logout">
            <span>@{state.user}</span>
            <button type="submit">Sign out</button>
          </form>
        )}
      </header>
      {onGraph ? (
        <>
          <div class={styles.tabs}>
            <Tabs
              tasks={tasks}
              repo={route.repo}
              onSelect={(repo) => go({ repo, task: null, run: null, page: "graph" })}
            />
          </div>
          <main class={styles.page}>
            <Graph
              state={state}
              refresh={refresh}
              repo={route.repo}
              vertical={!wide}
              showClosed={showClosed}
              onShowClosed={selectShowClosed}
            />
          </main>
        </>
      ) : onRepos && repos ? (
        <main class={styles.page}>
          <Repos
            list={repos}
            onBack={() => go({ repo: stored("tab") || null, task: null, run: null })}
            open={route.config ?? null}
            onOpen={(repo) =>
              go({ repo: null, task: null, run: null, page: "repositories", config: repo })
            }
          />
        </main>
      ) : (
        <>
          <div class={styles.tabs}>
            <Tabs tasks={tasks} repo={route.repo} onSelect={selectTab} />
          </div>
          <div class={styles.body}>
            <aside class={styles.side}>
              <TaskList
                tasks={inTab}
                chip={chip}
                onChip={selectChip}
                selected={task?.key ?? null}
                onSelect={(key) => go({ ...route, task: key, run: null }, true)}
                showRepo={!route.repo}
                now={now}
                loading={!state}
              />
            </aside>
            <main class={styles.main}>
              <Detail
                task={task}
                run={run ?? null}
                onRun={(id) => task && go({ ...route, task: task.key, run: id }, true)}
                onBack={() => go({ ...route, task: null, run: null }, true)}
                now={now}
                github={state?.githubUrl ?? "https://github.com"}
              />
            </main>
          </div>
        </>
      )}
    </div>
  );
}
