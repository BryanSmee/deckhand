// The dashboard: the shell (Shell.tsx: the sidebar, or a phone's bars) around a page: the
// Overview of every repo (what waits on you, a card per repo: Overview.tsx); a repo's tasks
// (or every repo's) filtered by state, the open task and its log; a repo's board, its work
// queue and what waits for what (Board.tsx); or Settings (Settings.tsx), whose Repositories
// tab is where onboarding starts and each one's config shows.
// What is shown lives in the address (route.ts); the state chip, the board's view, the repo
// last open and the sidebar's rail are kept on this device, like the choices of Settings ›
// Preferences (prefs.ts). On the board, the sidebar is a rail unless expanded there. The
// shortcuts of every page and of the tasks' list are bound here (keys.ts), with the `?` sheet
// (Shortcuts.tsx) and Ctrl K (Palette.tsx).
import { useEffect, useState } from "preact/hooks";
import { AccessContext, canFrom } from "./access";
import { type RepoList, useAppState, useChats, useHealth, useRepos } from "./api";
import { Board, type BoardView } from "./Board";
import { Chats } from "./Chats";
import { Detail } from "./Detail";
import { type ChipId, CHIPS, inChip, isLive, matchesSearch, repoTabs, sameRepo } from "./format";
import { useShortcuts, useShortcutsOn } from "./keys";
import { NewRequest, requestKinds } from "./NewRequest";
import { useNotifications } from "./notify";
import { Overview } from "./Overview";
import { type Jumps, Palette } from "./Palette";
import { getPref, nextTheme, setPref, usePref } from "./prefs";
import { needingYou } from "./Repos";
import { formatRoute, isOverview, parseRoute, type Route } from "./route";
import { Settings } from "./Settings";
import { PageHeader, type Request, Sidebar, TabBar, TopBar } from "./Shell";
import { ShortcutsDialog } from "./Shortcuts";
import { useSync } from "./Sync";
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

// The repo last open on this device, else (or if Preferences › Open on says so) the Overview.
const readStored = (): Route => ({
  repo: (getPref("openOn") === "last" && stored("tab")) || null,
  task: null,
  run: null,
});

// No address yet: readStored(). An old address (route.ts) is rewritten to its new one, in
// place.
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
  const [showClosed, setShowClosed] = usePref("showClosed");
  const [rail, setRail] = useState(() => stored("sidebar") === "rail");
  // The board's rail, expanded there for a while: not kept.
  const [boardRail, setBoardRail] = useState(true);
  // Graph or Lanes: a wide screen's graph unless picked; a phone's is a Preference (lanes).
  const [view, setView] = useState<BoardView>(() =>
    stored("boardView") === "lanes" ? "lanes" : "graph",
  );
  const [phoneView, setPhoneView] = usePref("phoneBoard");
  // The last repo open here, which All doesn't clear: the phone's Tasks and Board go there.
  const [lastRepo, setLastRepo] = useState(() => stored("repo") || null);
  // New request's dialog, and the kind it opened on: an idea or a bug report for a repo's
  // inbox, or a run that reviews a repo's recent runs; Ctrl K's may have its title typed.
  const [request, setRequest] = useState<{ kind: Request; title?: string } | null>(null);
  // The `?` sheet, Ctrl K, and the lane Ctrl K jumps to (its issues' keys), until in sight.
  const [help, setHelp] = useState(false);
  const [palette, setPalette] = useState(false);
  const [lane, setLane] = useState<string[] | null>(null);
  // The sidebar's Sync, which Ctrl K runs too: what it did shows in the sidebar when expanded,
  // else in a note of its own (the rail, a phone).
  const syncer = useSync(refresh);
  // Read for its re-render: the tooltips (keys.ts withKey()) name keys only while they are on.
  useShortcutsOn();
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
  // The services' health: the shell's alert, and Settings › Server, which reads it faster.
  // Only with server:read, which api/health needs (access.ts).
  const health = useHealth(
    onSettings && route.section === "server",
    canFrom(state?.access).server("server:read"),
  );
  const onBoard = route.page === "board";
  const onChats = route.page === "chats";
  // The user's chats: polled often on their page, else now and then for the sidebar's count,
  // or read once for a user who may start none (api.ts useChats()).
  const chats = useChats(onChats, canFrom(state?.access).anywhere("chat"));
  // Another repository's chat under a repository's chats (an old link): its own repository's.
  const elsewhere =
    (onChats &&
      route.repo &&
      route.chat &&
      chats.data?.chats.find((c) => c.id === route.chat && !sameRepo(c.repo, route.repo))) ||
    null;
  useEffect(() => {
    if (elsewhere) go({ ...route, repo: elsewhere.repo }, true);
  }, [elsewhere?.repo]);
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
    if (!wide) return setPhoneView(next);
    store("boardView", next);
    setView(next);
  };

  const notify = useNotifications(state);
  const github = state?.githubUrl ?? "https://github.com";
  const shell = {
    state,
    error,
    route,
    syncer,
    health: health.data,
    chats: chats.data,
    onRequest: (kind: Request) => setRequest({ kind }),
  };
  const railed = onBoard ? boardRail : rail;
  const onTasks = !overview && !onBoard && !onSettings && !onChats;
  const shownRepo = onSettings ? null : route.repo;
  const page = (next: Partial<Route>) => go({ repo: null, task: null, run: null, ...next });

  // The lane Ctrl K picked, once the board shows it: the one with any of its issues (a pending
  // action may have moved one since).
  useEffect(() => {
    if (!lane || !onBoard) return;
    let tries = 0;
    const timer = setInterval(() => {
      const el = lane
        .map((key) => document.querySelector<HTMLElement>(`[data-lane~="${CSS.escape(key)}"]`))
        .find(Boolean);
      if (el || ++tries > 20) {
        clearInterval(timer);
        setLane(null);
        el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        el?.querySelector<HTMLElement>("[data-card]")?.focus();
      }
    }, 50);
    return () => clearInterval(timer);
  }, [lane, onBoard]);

  const jumps: Jumps = {
    task: (t) => go({ repo: t.repo, task: t.key, run: null }),
    repo: (repo) => go({ repo, task: null, run: null }),
    lane: (repo, keys) => {
      selectView("lanes");
      setLane(keys);
      go({ repo, task: null, run: null, page: "board" });
    },
    request: (kind, title) => setRequest({ kind, title }),
    sync: () => void syncer.sync(),
    theme: (theme) => setPref("theme", theme),
  };

  useShortcuts({
    help: () => setHelp(true),
    palette: () => (state ? setPalette(true) : false),
    request: () =>
      state && requestKinds(canFrom(state.access)).length ? setRequest({ kind: "idea" }) : false,
    overview: () => page({}),
    tasks: () => page(shownRepo ? { repo: shownRepo } : { page: "tasks" }),
    board: () => {
      const repo = shownRepo ?? lastRepo ?? repoTabs(tasks)[0]?.repo;
      if (!repo) return false;
      page({ repo, page: "board" });
    },
    settings: () => page({ page: "settings" }),
    sidebar: () => (wide ? selectRail(!railed) : false),
    theme: () => setPref("theme", nextTheme(getPref("theme"))),
    // A phone's open task goes back to the list, an open config to the repositories.
    back: () => {
      if (task && !wide) return go({ ...route, task: null, run: null }, true);
      if (onSettings && route.config) return page({ page: "settings" });
      if (onChats && route.chat && !wide) return page({ repo: route.repo, page: "chats" });
      return false;
    },
  });
  // The list's: the next or previous task shown, a state chip.
  useShortcuts(
    {
      nextTask: (i) => {
        if (!visible.length) return false;
        const at = visible.findIndex((t) => t.key === task?.key);
        const next =
          at < 0 ? 0 : Math.min(visible.length - 1, Math.max(0, at + (i === 0 ? 1 : -1)));
        go({ ...route, task: visible[next].key, run: null }, true);
      },
      filter: (i) => selectChip(CHIPS[i].id),
    },
    onTasks,
  );
  // A phone's search button opens the box, and closes it emptied.
  const toggleSearch = () => {
    if (searchOpen) setQuery("");
    setSearchOpen(!searchOpen);
  };

  return (
    <AccessContext.Provider value={canFrom(state?.access)}>
      <div class={`${styles.app} ${task || (onChats && route.chat) ? styles.reading : ""}`}>
        {wide ? (
          <Sidebar {...shell} repos={repos} rail={railed} onRail={selectRail} notify={notify} />
        ) : (
          <TopBar {...shell} onSearch={onTasks && !task ? toggleSearch : undefined} />
        )}
        <div class={styles.content}>
          {/* A repository's config has its own header, its way back included. */}
          {wide && !(onBoard && route.repo) && !(onSettings && route.config) && (
            <PageHeader
              route={route}
              github={github}
              needs={needingYou(repos?.repos ?? null, tasks)}
              state={state}
              chats={chats.data}
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
                onShowClosed={setShowClosed}
                view={wide ? view : phoneView}
                onView={selectView}
                header={(controls) => (
                  <PageHeader route={route} github={github} state={state} chats={chats.data}>
                    {controls}
                  </PageHeader>
                )}
              />
            </div>
          ) : onChats ? (
            <div class={styles.page}>
              <Chats
                polled={chats}
                repo={route.repo}
                open={route.chat ?? null}
                onOpen={(id, repo) => page({ repo, page: "chats", chat: id })}
                now={now}
                touch={!wide}
              />
            </div>
          ) : onSettings ? (
            <main class={styles.page}>
              {repos && (
                <Settings
                  route={route}
                  state={state}
                  error={error}
                  repos={repos}
                  narrow={!wide}
                  refresh={refresh}
                  health={health.data}
                  healthError={health.error}
                  notify={notify}
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
        {!wide && !task && !(onChats && route.chat) && (
          <TabBar state={state} route={route} lastRepo={lastRepo} chats={chats.data} />
        )}
        {request && state && (
          <NewRequest
            kind={request.kind}
            title={request.title}
            inboxes={state.inboxes}
            tasks={tasks}
            repo={route.repo}
            onClose={() => setRequest(null)}
            onSent={() => void refresh?.()}
          />
        )}
        {syncer.said && !(wide && !railed) && (
          <p role="status" class={`${styles.note} ${syncer.said.failed ? styles.failed : ""}`}>
            {syncer.said.text}
          </p>
        )}
        {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
        {palette && state && (
          <Palette
            state={state}
            repos={repos?.repos?.map((r) => r.repo)}
            showClosed={showClosed}
            jumps={jumps}
            onClose={() => setPalette(false)}
          />
        )}
      </div>
    </AccessContext.Provider>
  );
}
