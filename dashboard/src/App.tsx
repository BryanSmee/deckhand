// The dashboard: the shell (Shell.tsx: the sidebar, or a phone's bars) around a page: a repo's
// tasks (or every repo's) filtered by state, the open task and its log; a repo's board, the
// graph of what waits for what; or Settings, the repositories page, where onboarding starts
// and each one's config shows.
// What is shown lives in the address (route.ts); the state chip, the graph's "Show closed",
// the repo last open and the sidebar's rail are kept on this device.
import { useEffect, useState } from "preact/hooks";
import { AnalyzeDialog, analysisRepos } from "./Analyze";
import { type RepoList, useAppState, useRepos } from "./api";
import { Detail } from "./Detail";
import { Graph } from "./Graph";
import { InboxDialog } from "./Inbox";
import { type ChipId, CHIPS, inChip, isLive, repoTabs, sameRepo } from "./format";
import { useReadyNotifications } from "./notify";
import { Repos } from "./Repos";
import { formatRoute, parseRoute, type Route } from "./route";
import { PageHeader, type Request, Sidebar, TabBar, TopBar } from "./Shell";
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

// No address yet: the repo last open on this device. An old address (route.ts) is rewritten
// to its new one, in place.
function readRoute(): Route {
  if (location.hash.length <= 1) return { repo: stored("tab") || null, task: null, run: null };
  const route = parseRoute(location.hash);
  const hash = formatRoute(route);
  if (hash !== location.hash) history.replaceState(null, "", hash);
  return route;
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
  const [rail, setRail] = useState(() => stored("sidebar") === "rail");
  // New request's dialogs: an idea or a bug report for a repo's inbox (Feedback), or a run
  // that reviews a repo's recent runs (Analyze).
  const [request, setRequest] = useState<Request | null>(null);
  const wide = useWide();
  const tasks = state?.tasks ?? [];
  const now = state?.now ?? Date.now();
  // The address's repo as the sidebar spells it: GitHub ignores case, a link may not match.
  const tabRepo =
    (route.repo && repoTabs(tasks).find((t) => sameRepo(t.repo, route.repo))?.repo) || route.repo;
  const inTab = route.repo ? tasks.filter((t) => sameRepo(t.repo, route.repo)) : tasks;

  const task = (route.task && tasks.find((t) => t.key === route.task)) || null;
  const run = (task && route.run && task.runs.find((r) => r.id === route.run)) || task?.runs[0];
  // A wide screen has room for a task: the first live one, else the first one, once.
  const visible = inTab.filter((t) => inChip(chip, t));
  const first = visible.find(isLive) ?? visible[0];
  const onSettings = route.page === "settings";
  const onBoard = route.page === "board";
  // The address takes the sidebar's spelling, so links copied from it are the canonical ones.
  useEffect(() => {
    if (tabRepo !== route.repo) go({ ...route, repo: tabRepo }, true);
  }, [tabRepo, route.repo]);
  useEffect(() => {
    if (wide && !route.page && !route.task && first)
      go({ ...route, repo: tabRepo, task: first.key, run: null }, true);
  }, [wide, route.page, route.task, first?.key]);
  // The repo shown is the one to come back to (Tasks and Board on a phone, an empty address).
  useEffect(() => {
    if (!onSettings) store("tab", route.repo ?? "");
  }, [onSettings, route.repo]);

  const selectShowClosed = (show: boolean) => {
    store("graphClosed", show ? "1" : "");
    setShowClosed(show);
  };
  const selectChip = (next: ChipId) => {
    store("chip", next);
    setChip(next);
  };
  const selectRail = (next: boolean) => {
    store("sidebar", next ? "rail" : "");
    setRail(next);
  };

  const notify = useReadyNotifications(state);
  const github = state?.githubUrl ?? "https://github.com";
  const shell = { state, error, route, refresh, onRequest: setRequest };

  return (
    <div class={`${styles.app} ${task ? styles.reading : ""}`}>
      {wide ? (
        <Sidebar {...shell} repos={repos} rail={rail} onRail={selectRail} notify={notify} />
      ) : (
        <TopBar {...shell} />
      )}
      <div class={styles.content}>
        {wide && <PageHeader route={route} github={github} />}
        {onBoard ? (
          <main class={styles.page}>
            <Graph
              state={state}
              refresh={refresh}
              repo={route.repo}
              narrow={!wide}
              showClosed={showClosed}
              onShowClosed={selectShowClosed}
            />
          </main>
        ) : onSettings ? (
          <main class={styles.page}>
            {repos && (
              <Repos
                list={repos}
                onBack={() => go({ repo: stored("tab") || null, task: null, run: null })}
                open={route.config ?? null}
                server={state?.server}
                serverNow={state?.now}
                onOpen={(repo) =>
                  go({ repo: null, task: null, run: null, page: "settings", config: repo })
                }
              />
            )}
          </main>
        ) : (
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
                github={github}
                refresh={refresh}
              />
            </main>
          </div>
        )}
      </div>
      {!wide && !task && <TabBar state={state} route={route} lastRepo={stored("tab") || null} />}
      {request === "inbox" && state && (
        <InboxDialog
          inboxes={state.inboxes}
          tasks={tasks}
          repo={route.repo}
          onClose={() => setRequest(null)}
          onSent={() => void refresh?.()}
        />
      )}
      {request === "analyze" && state && (
        <AnalyzeDialog
          repos={analysisRepos(state.inboxes, tasks)}
          tasks={tasks}
          repo={route.repo}
          onClose={() => setRequest(null)}
          onSent={() => void refresh?.()}
        />
      )}
    </div>
  );
}
