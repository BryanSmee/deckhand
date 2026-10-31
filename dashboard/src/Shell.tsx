// The app shell (docs/design/dashboard-redesign.md › Layout › App shell). On a wide screen, the
// sidebar (Deckhand, New request, the repositories, Settings, the run slots and the user), or
// its 64 px rail, and a page header (the repository, its GitHub link, Tasks | Board; Overview |
// Tasks on All). On a phone, a top bar (the repository switcher, New request) and a tab bar
// (Overview, Tasks, Board, Settings). Links keep the view: a repository's link from its board
// opens the other's, and All's from a board opens the Overview (the board is one repo's).
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { RepoList } from "./api";
import {
  plural,
  type RepoCounts,
  repoCounts,
  reservedText,
  runningText,
  sameRepo,
  shortRepo,
} from "./format";
import { withKey } from "./keys";
import type { Permission } from "./notify";
import { needingYou } from "./Repos";
import { SettingsTabs } from "./Settings";
import { formatRoute, isOverview, type Route } from "./route";
import type { Syncer } from "./Sync";
import type { State } from "./types";
import { Button, IconButton } from "./ui/Button";
import { type Segment, Segmented } from "./ui/Choice";
import * as Icon from "./ui/icons";
import { NavItem } from "./ui/NavItem";
import { Sheet } from "./ui/Sheet";
import { Meter } from "./ui/Meter";
import { StatusDot } from "./ui/Status";
import { usePopup } from "./ui/popup";
import { ThemeSwitch } from "./ui/ThemeSwitch";
import styles from "./Shell.module.css";

// What New request's menu opens: the dialog, on that kind (NewRequest.tsx).
export type Request = "idea" | "bug" | "analyze";

const REQUESTS: { id: Request; label: string; icon: ComponentChildren }[] = [
  { id: "idea", label: "Idea", icon: <Icon.Idea /> },
  { id: "bug", label: "Bug report", icon: <Icon.Bug /> },
  { id: "analyze", label: "Analyze runs", icon: <Icon.Chart /> },
];

const tasksOf = (repo: string | null) => formatRoute({ repo, task: null, run: null });
const boardOf = (repo: string | null) =>
  formatRoute({ repo, task: null, run: null, page: "board" });
const allTasks = formatRoute({ repo: null, task: null, run: null, page: "tasks" });
const onTasks = (route: Route) => route.page === "tasks" || (!route.page && !!route.repo);

// A repository's link: its board from a board, else its tasks. All's: its tasks from All's
// tasks, else the Overview.
const repoHref = (route: Route, repo: string | null) => {
  if (!repo) return route.page === "tasks" && !route.repo ? allTasks : tasksOf(null);
  return route.page === "board" ? boardOf(repo) : tasksOf(repo);
};

interface Common {
  state: State | null;
  route: Route;
}

interface SidebarProps extends Common {
  error: string | null;
  repos?: RepoList;
  rail: boolean;
  onRail: (rail: boolean) => void;
  onRequest: (request: Request) => void;
  notify: { permission: Permission; ask: () => void };
  syncer: Syncer;
}

export function Sidebar(props: SidebarProps) {
  const { state, route, repos, rail, onRail, onRequest, notify } = props;
  const counts = repoCounts(state?.tasks ?? [], route.repo);
  const waiting = needingYou(repos?.repos ?? null, state?.tasks ?? []);
  const toggle = (
    <IconButton
      variant="ghost"
      size={rail ? "default" : "small"}
      class={rail ? "" : styles.collapse}
      label={rail ? "Expand the sidebar" : "Collapse the sidebar"}
      title={withKey(rail ? "Expand the sidebar" : "Collapse the sidebar", "sidebar")}
      icon={<Icon.Sidebar />}
      onClick={() => onRail(!rail)}
    />
  );
  return (
    <aside class={`${styles.side} ${rail ? styles.rail : ""}`} aria-label="Deckhand">
      <div class={styles.brand}>
        <span class={styles.logo} title={rail ? "Deckhand" : undefined} aria-hidden="true">
          <Icon.Anchor size={rail ? 17 : 16} />
        </span>
        {!rail && (
          <a class={styles.name} href={tasksOf(null)}>
            Deckhand
          </a>
        )}
        {!rail && toggle}
      </div>
      {state && <NewRequest onPick={onRequest} form={rail ? "icon" : "full"} />}
      {rail && <span class={styles.rule} />}
      <RepoLinks counts={counts} route={route} rail={rail} />
      <div class={styles.bottom}>
        {repos && (
          <NavItem
            href={formatRoute({ repo: null, task: null, run: null, page: "settings" })}
            icon={<Icon.Settings size={rail ? 17 : 16} />}
            label="Settings"
            current={route.page === "settings"}
            count={waiting}
            title={withKey(
              waiting
                ? `${plural(waiting, "repository", "repositories")} ${waiting === 1 ? "needs" : "need"} you`
                : "Settings",
              "settings",
            )}
            rail={rail}
          />
        )}
        {notify.permission === "default" && (
          <NavItem
            onClick={notify.ask}
            icon={<Icon.Bell size={rail ? 17 : 16} />}
            label="Notify me when ready"
            title="Browser notifications while this page is open: a pull request ready for review, a run that needs your answers (Settings › Preferences picks which)"
            rail={rail}
          />
        )}
      </div>
      <RunSlots {...props} />
      {rail ? toggle : state && <User user={state.user} />}
    </aside>
  );
}

// All repositories, then each repository with its running dot and what waits on you.
// In the phone's sheet (`touch`): 44 px high, under the sheet's own title.
function RepoLinks({
  counts,
  route,
  rail,
  touch,
}: {
  counts: ReturnType<typeof repoCounts>;
  route: Route;
  rail?: boolean;
  touch?: boolean;
}) {
  const shown = route.page !== "settings";
  const dot = (c: RepoCounts) => (
    <span class={styles.dot}>
      <StatusDot tone={c.live ? "run" : "idle"} pulse={c.moving} />
    </span>
  );
  return (
    <nav class={`${styles.repos} ${touch ? styles.touch : ""}`} aria-label="Repositories">
      {!rail && !touch && <h2 class={styles.heading}>Repositories</h2>}
      <NavItem
        href={repoHref(route, null)}
        icon={<Icon.Overview size={rail ? 17 : 16} />}
        label="All repositories"
        current={shown && !route.repo}
        count={counts.all.input}
        hot
        rail={rail}
      />
      {counts.repos.map((c) => (
        <NavItem
          key={c.repo}
          href={repoHref(route, c.repo)}
          icon={rail ? <span class={styles.short}>{shortRepo(c.repo)}</span> : dot(c)}
          label={c.repo}
          title={c.live ? `${c.repo}: ${c.live} running` : c.repo}
          current={shown && sameRepo(route.repo, c.repo)}
          count={c.input}
          hot
          rail={rail}
        />
      ))}
    </nav>
  );
}

// "2 of 4 running", a slot per run (a bar when there are many), the queue and preview hooks,
// and Sync. On the rail, the slots and Sync as an icon: what it did is in its title, and in the
// dashboard's note (App.tsx) for screen readers.
function RunSlots({
  state,
  error,
  syncer,
  rail,
}: Pick<SidebarProps, "state" | "error" | "syncer"> & { rail?: boolean }) {
  const { syncing, said, sync } = syncer;
  if (error) {
    const text = `Can't reach the listener (${error})`;
    return rail ? (
      <span class={styles.railError} role="img" aria-label={text} title={text}>
        <Icon.Alert size={18} />
      </span>
    ) : (
      <div class={`${styles.slots} ${styles.failed}`} role="alert">
        {text}
      </div>
    );
  }
  if (!state) return rail ? null : <div class={styles.slots}>Loading…</div>;
  const { running, maxParallel: max, queued } = state;
  const hooks = state.previews?.length ?? 0;
  const summary = runningText(state);
  const rest = [
    `${queued} queued`,
    reservedText(state) ?? "",
    hooks ? plural(hooks, "preview hook") : "",
  ].filter(Boolean);
  const meter = (
    <Meter running={running} max={max} rail={rail} title={[summary, ...rest].join(" · ")} />
  );
  const syncButton = (
    <IconButton
      variant="ghost"
      size={rail ? "default" : "small"}
      class={rail && said?.failed ? styles.railFailed : undefined}
      label="Sync with GitHub"
      icon={<Icon.Sync size={rail ? 17 : 15} />}
      pending={syncing}
      onClick={() => void sync()}
      title={
        rail && said
          ? said.text
          : "Ask GitHub again for the webhook deliveries it couldn't hand over, and for the open pull requests' states"
      }
    />
  );
  if (rail)
    return (
      <>
        {meter}
        {syncButton}
      </>
    );
  return (
    <div class={styles.slots}>
      <div class={styles.slotsHead}>
        <span class={styles.slotsTitle}>{summary}</span>
        {syncButton}
      </div>
      {meter}
      <span class={styles.slotsMeta}>{rest.join(" · ")}</span>
      {said && (
        <span role="status" class={said.failed ? styles.syncFailed : styles.synced}>
          {said.text}
        </span>
      )}
    </div>
  );
}

// The user's login, the theme switch and Sign out. (No avatar: the login needs its room.)
function User({ user }: { user: string }) {
  return (
    <div class={styles.user}>
      <span class={styles.login} title={`Signed in as @${user}`}>
        @{user}
      </span>
      <ThemeSwitch class={styles.theme} />
      <form class={styles.logout} method="post" action="auth/logout">
        <IconButton
          type="submit"
          variant="ghost"
          size="small"
          label="Sign out"
          icon={<Icon.SignOut size={15} />}
        />
      </form>
    </div>
  );
}

// New request and its menu. Arrows move through it, Escape closes it, and so does a click
// elsewhere (ui/popup.ts). On the rail the menu opens beside it, outside the sidebar: the
// sidebar scrolls, so it would clip an absolute menu there. It is fixed instead, at the button.
function NewRequest({
  onPick,
  form,
}: {
  onPick: (r: Request) => void;
  form: "full" | "icon" | "bar";
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const button = () => box.current?.querySelector<HTMLElement>("[aria-haspopup]");
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);
  usePopup(open, () => setOpen(false), {
    box,
    button,
    fixed: form === "icon",
    onKey: (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const all = items();
      const at = all.indexOf(document.activeElement as HTMLElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      all[(at + step + all.length) % all.length]?.focus();
    },
  });
  const attrs = {
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    onClick: (e: MouseEvent) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setAt({ top: r.top, left: r.right + 8 });
      setOpen(!open);
    },
  };
  return (
    <div class={`${styles.request} ${styles[form]}`} ref={box}>
      {form === "full" ? (
        <Button {...attrs} class={styles.requestButton} icon={<Icon.Plus />} shortcut="request">
          New request
        </Button>
      ) : (
        <IconButton
          {...attrs}
          variant={form === "bar" ? "ghost" : "secondary"}
          size={form === "bar" ? "touch" : "default"}
          label="New request"
          title={withKey("New request", "request")}
          icon={<Icon.Plus size={form === "bar" ? 20 : 16} />}
        />
      )}
      {open && (
        <div
          class={styles.menu}
          role="menu"
          aria-label="New request"
          ref={menu}
          style={form === "icon" ? { top: `${at.top}px`, left: `${at.left}px` } : undefined}
        >
          {REQUESTS.map((r) => (
            <button
              key={r.id}
              type="button"
              role="menuitem"
              class={styles.menuItem}
              tabIndex={-1}
              onClick={() => {
                // Focus back on New request first: the dialog gives it back there once closed.
                button()?.focus();
                setOpen(false);
                onPick(r.id);
              }}
            >
              {r.icon}
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The page's title, its GitHub link, its views and the page's own controls (`children`: the
// board's Start in); Settings' tabs under its title. `needs`: the repositories that need you,
// on the Repositories tab.
export function PageHeader({
  route,
  github,
  needs = 0,
  children,
}: {
  route: Route;
  github: string;
  needs?: number;
  children?: ComponentChildren;
}) {
  const settings = route.page === "settings";
  const repo = settings ? null : route.repo;
  // The board is one repository's: All has the Overview instead.
  const views: Segment<"overview" | "tasks" | "board">[] = repo
    ? [
        {
          value: "tasks",
          label: "Tasks",
          icon: <Icon.Tasks size={14} />,
          href: tasksOf(repo),
          title: withKey("Tasks", "tasks"),
        },
        {
          value: "board",
          label: "Board",
          icon: <Icon.Board size={14} />,
          href: boardOf(repo),
          title: withKey("Board", "board"),
        },
      ]
    : [
        {
          value: "overview",
          label: "Overview",
          icon: <Icon.Overview size={14} />,
          href: tasksOf(null),
          title: withKey("Overview", "overview"),
        },
        {
          value: "tasks",
          label: "Tasks",
          icon: <Icon.Tasks size={14} />,
          href: allTasks,
          title: withKey("Tasks", "tasks"),
        },
      ];
  const view = isOverview(route) ? "overview" : route.page === "board" ? "board" : "tasks";
  return (
    <header class={`${styles.header} ${settings ? styles.tabbed : ""}`}>
      <div class={styles.title}>
        <h1>{settings ? "Settings" : (repo ?? "All repositories")}</h1>
        {repo && (
          <a
            class={styles.github}
            href={`${github}/${repo}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`${repo} on GitHub`}
            title="Open on GitHub"
          >
            <Icon.External size={14} />
          </a>
        )}
      </div>
      {settings && <SettingsTabs route={route} count={needs} class={styles.headerTabs} />}
      {!settings && <Segmented label="View" options={views} value={view} />}
      {!settings && !repo && (
        <span class={styles.hint}>The board is per repository: open one to plan its work.</span>
      )}
      {children && <div class={styles.controls}>{children}</div>}
    </header>
  );
}

interface TopBarProps extends Common {
  error: string | null;
  syncer: Syncer;
  onRequest: (request: Request) => void;
  // The Tasks page's: opens or closes the list's search box.
  onSearch?: () => void;
}

// The phone's top bar: the repository switcher, whose sheet lists the sidebar's repositories,
// then the run slots and the user; Search on the Tasks page, and New request. Under it, the
// listener's error, if any: the sidebar's run slots say it on a wide screen.
export function TopBar(props: TopBarProps) {
  const { state, route, error, onRequest, onSearch } = props;
  const [sheet, setSheet] = useState(false);
  const counts = repoCounts(state?.tasks ?? [], route.repo);
  const settings = route.page === "settings";
  const current = settings ? null : counts.repos.find((c) => sameRepo(c.repo, route.repo));
  const label = settings ? "Settings" : (current?.repo ?? "All repositories");
  return (
    <>
      <header class={styles.topbar}>
        <button
          type="button"
          class={styles.switcher}
          aria-haspopup="dialog"
          aria-expanded={sheet}
          aria-label={`${label}: switch repository`}
          onClick={() => setSheet(true)}
        >
          {current && <StatusDot tone={current.live ? "run" : "idle"} pulse={current.moving} />}
          <span class={styles.switcherLabel}>{label}</span>
          <Icon.ChevronDown class={styles.chevron} />
        </button>
        {onSearch && (
          <IconButton
            variant="ghost"
            size="touch"
            label="Search tasks"
            icon={<Icon.Search size={20} />}
            onClick={onSearch}
          />
        )}
        {state && <NewRequest onPick={onRequest} form="bar" />}
        {sheet && (
          <Sheet title="Repositories" onClose={() => setSheet(false)}>
            <RepoLinks counts={counts} route={route} touch />
            <RunSlots {...props} />
            {state && <User user={state.user} />}
          </Sheet>
        )}
      </header>
      {error && (
        <p class={styles.banner} role="alert">
          Can't reach the listener ({error})
        </p>
      )}
    </>
  );
}

// The phone's tab bar. Tasks and Board are the repository shown, else the one last open
// here. Else Tasks are All's (and stay All's on them), and Board the most recently active
// repository's: the board is one repository's.
export function TabBar({ state, route, lastRepo }: Common & { lastRepo: string | null }) {
  const counts = repoCounts(state?.tasks ?? [], route.repo);
  const onAllTasks = route.page === "tasks" && !route.repo;
  const tasksRepo = route.repo ?? (onAllTasks ? null : lastRepo);
  const repo = route.repo ?? lastRepo ?? counts.repos[0]?.repo ?? null;
  const tabs = [
    {
      label: "Overview",
      icon: <Icon.Overview size={22} />,
      href: tasksOf(null),
      current: isOverview(route),
      count: counts.all.input,
    },
    {
      label: "Tasks",
      icon: <Icon.Tasks size={22} />,
      href: tasksRepo ? tasksOf(tasksRepo) : allTasks,
      current: onTasks(route),
    },
    {
      label: "Board",
      icon: <Icon.Board size={22} />,
      href: repo ? boardOf(repo) : tasksOf(null),
      current: route.page === "board",
    },
    {
      label: "Settings",
      icon: <Icon.Settings size={22} />,
      href: formatRoute({ repo: null, task: null, run: null, page: "settings" }),
      current: route.page === "settings",
    },
  ];
  return (
    <nav class={styles.tabbar} aria-label="Pages">
      {tabs.map((t) => (
        <a
          key={t.label}
          href={t.href}
          aria-current={t.current ? "page" : undefined}
          aria-label={t.count ? `${t.label} (${t.count} waiting on you)` : undefined}
        >
          {t.icon}
          {t.label}
          {!!t.count && (
            <span class={styles.pip} aria-hidden="true">
              {t.count}
            </span>
          )}
        </a>
      ))}
    </nav>
  );
}
