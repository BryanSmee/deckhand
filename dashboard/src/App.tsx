// The dashboard: the shell (Shell.tsx: the sidebar, or a phone's bars) around a page: the
// Overview of every repo (what waits on you, a card per repo: Overview.tsx); a repo's tasks
// (or every repo's) filtered by state, the open task and its log; a repo's board, its work
// queue and what waits for what (Board.tsx); or Settings (Settings.tsx), whose Repositories
// tab is where onboarding starts and each one's config shows.
// What is shown lives in the address (route.ts); the state chip, the board's view and "Show
// closed", the repo last open and the sidebar's rail are kept on this device. On the board, the
// sidebar is a rail unless expanded there.
import { useEffect, useState } from "preact/hooks";
import { AnalyzeDialog, analysisRepos } from "./Analyze";
import { type RepoList, useAppState, useRepos } from "./api";
import { Board, type BoardView } from "./Board";
import { Detail } from "./Detail";
import { InboxDialog } from "./Inbox";
import { type ChipId, CHIPS, inChip, isLive, matchesSearch, repoTabs, sameRepo } from "./format";
import { useReadyNotifications } from "./notify";
import { Overview } from "./Overview";
import { needingYou } from "./Repos";
import { formatRoute, isOverview, parseRoute, type Route } from "./route";
import { Settings } from "./Settings";
import { PageHeader, type Request, Sidebar, TabBar, TopBar } from "./Shell";
import { TaskList } from "./TaskList";
import type { State } from "./types";
import styles from "./App.module.css";

export function App() {
  const { state, error, refresh } = useAppState();
  // The Overview's cards show each repo's backlog: only it asks for them.
  const [overview, setOverview] = useState(() => isOverview(parseRoute(location.hash)));
  const repos = useRepos(overview);
  return (
    <Dashboard
      state={state}
      error={error}
      repos={repos}
      refresh={refresh}
      onOverview={setOverview}
    />
  );
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

// The repo last open on this device, else the Overview.
const readStored = (): Route => ({ repo: stored("tab") || null, task: null, run: null });

// No address yet: the repo last open on this device. An old address (route.ts) is rewritten
// to its new one, in place.
function readRoute(): Route {
  if (location.hash.length <= 1) return readStored();
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
  // Whether the Overview is shown, each time that changes.
  onOverview?: (shown: boolean) => void;
}

export function Dashboard({ state, error, repos, refresh, onOverview }: Props) {
  const [route, go] = useRoute();
  const [chip, setChip] = useState<ChipId>(() => {
    const saved = stored("chip");
    return CHIPS.some((c) => c.id === saved) ? (saved as ChipId) : "all";
  });
  // The list's search, and whether a phone shows its box (a wide screen always does).
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [showClosed, setShowClosed] = useState(() => stored("graphClosed") === "1");
  const [rail, setRail] = useState(() => stored("sidebar") === "rail");
  // The board's rail, expanded there for a while: not kept.
  const [boardRail, setBoardRail] = useState(true);
  // Graph or Lanes; a phone's lanes unless picked.
  const [view, setView] = useState<BoardView | null>(() => {
    const saved = stored("boardView");
    return saved === "graph" || saved === "lanes" ? saved : null;
  });
  // The last repo open here, which All doesn't clear: the phone's Tasks and Board go there.
  const [lastRepo, setLastRepo] = useState(() => stored("repo") || null);
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
  const visible = inTab.filter((t) => inChip(chip, t) && matchesSearch(t, query));
  const first = visible.find(isLive) ?? visible[0];
  const onSettings = route.page === "settings";
  const onBoard = route.page === "board";
  const overview = isOverview(route);
  useEffect(() => onOverview?.(overview), [overview]);
  // The address takes the sidebar's spelling, so links copied from it are the canonical ones.
  useEffect(() => {
    if (tabRepo !== route.repo) go({ ...route, repo: tabRepo }, true);
  }, [tabRepo, route.repo]);
  useEffect(() => {
    if (wide && !overview && (!route.page || route.page === "tasks") && !route.task && first)
      go({ ...route, repo: tabRepo, task: first.key, run: null }, true);
  }, [wide, overview, route.page, route.task, first?.key]);
  // The repo shown is the one to come back to (Tasks and Board on a phone, an empty address).
  useEffect(() => {
    if (!onSettings) store("tab", route.repo ?? "");
    if (route.repo) {
      store("repo", route.repo);
      setLastRepo(route.repo);
    }
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
    if (onBoard) return setBoardRail(next);
    store("sidebar", next ? "rail" : "");
    setRail(next);
  };
  const selectView = (next: BoardView) => {
    store("boardView", next);
    setView(next);
  };

  const notify = useReadyNotifications(state);
  const github = state?.githubUrl ?? "https://github.com";
  const shell = { state, error, route, refresh, onRequest: setRequest };
  const onTasks = !overview && !onBoard && !onSettings;
  // A phone's search button opens the box, and closes it emptied.
  const toggleSearch = () => {
    if (searchOpen) setQuery("");
    setSearchOpen(!searchOpen);
  };

  return (
    <div class={`${styles.app} ${task ? styles.reading : ""}`}>
      {wide ? (
        <Sidebar
          {...shell}
          repos={repos}
          rail={onBoard ? boardRail : rail}
          onRail={selectRail}
          notify={notify}
        />
      ) : (
        <TopBar {...shell} onSearch={onTasks && !task ? toggleSearch : undefined} />
      )}
      <div class={styles.content}>
        {wide && !(onBoard && route.repo) && (
          <PageHeader
            route={route}
            github={github}
            needs={needingYou(repos?.repos ?? null, tasks)}
          />
        )}
        {overview ? (
          <main class={styles.page}>
            <Overview
              state={state}
              repos={repos}
              github={github}
              refresh={refresh}
              onChip={selectChip}
            />
          </main>
        ) : onBoard && route.repo ? (
          <div class={styles.page}>
            <Board
              state={state}
              refresh={refresh}
              repo={route.repo}
              narrow={!wide}
              showClosed={showClosed}
              onShowClosed={selectShowClosed}
              view={view ?? (wide ? "graph" : "lanes")}
              onView={selectView}
              header={(controls) => (
                <PageHeader route={route} github={github}>
                  {controls}
                </PageHeader>
              )}
            />
          </div>
        ) : onSettings ? (
          <main class={styles.page}>
            {repos && (
              <Settings
                route={route}
                state={state}
                repos={repos}
                narrow={!wide}
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
                query={query}
                onQuery={setQuery}
                searching={wide || searchOpen}
                onSearching={setSearchOpen}
                selected={task?.key ?? null}
                onSelect={(key) => go({ ...route, task: key, run: null }, true)}
                showRepo={!route.repo}
                now={now}
                loading={!state}
                touch={!wide}
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
                showRepo={!route.repo}
                touch={!wide}
                refresh={refresh}
              />
            </main>
          </div>
        )}
      </div>
      {!wide && !task && <TabBar state={state} route={route} lastRepo={lastRepo} />}
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
