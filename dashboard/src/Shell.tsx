// The app shell (docs/design/dashboard-redesign.md › Layout › App shell). On a wide screen, the
// sidebar (Deckhand, New request, the repositories, Settings, the run slots and the user), or
// its 64 px rail, and a page header (the repository, its GitHub link, Tasks | Board; Overview |
// Tasks on All). On a phone, a top bar (the repository switcher, New request) and a tab bar
// (Overview, Tasks, Board, Chats, Settings). Links keep the view: a repository's link from its
// board or its chats opens the other's, All's from a board opens the Overview (the board is one
// repo's), and from chats every repo's chats.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { type Can, useCan } from "./access";
import type { RepoList } from "./api";
import {
  type RepoCounts,
  repoCounts,
  reservedText,
  runningText,
  sameRepo,
  shortRepo,
} from "./format";
import { HealthAlert } from "./Health";
import { t } from "./i18n";
import { withKey } from "./keys";
import type { Permission } from "./notify";
import { requestKinds } from "./NewRequest";
import { RepoSlots } from "./RepoSlots";
import { needingYou } from "./Repos";
import { SettingsTabs } from "./Settings";
import { formatRoute, isOverview, type Route } from "./route";
import type { Syncer } from "./Sync";
import type { Plain } from "./locales";
import type { Chats, Health, State } from "./types";
import { Button, IconButton } from "./ui/Button";
import { type Segment, Segmented } from "./ui/Choice";
import * as Icon from "./ui/icons";
import { NavItem } from "./ui/NavItem";
import { Sheet } from "./ui/Sheet";
import { Meter } from "./ui/Meter";
import { PlanBars } from "./ui/PlanUsage";
import { StatusDot } from "./ui/Status";
import { usePopup } from "./ui/popup";
import { ThemeSwitch } from "./ui/ThemeSwitch";
import styles from "./Shell.module.css";

// What New request's menu opens: the dialog, on that kind (NewRequest.tsx).
export type Request = "idea" | "bug" | "analyze";

const REQUESTS: { id: Request; label: Plain; icon: ComponentChildren }[] = [
  { id: "idea", label: "shell.requestIdea", icon: <Icon.Idea /> },
  { id: "bug", label: "shell.requestBug", icon: <Icon.Bug /> },
  { id: "analyze", label: "shell.requestAnalyze", icon: <Icon.Chart /> },
];

// The menu's kinds the user may send somewhere (access.ts): none, no New request.
const menuRequests = (can: Can) => {
  const kinds = requestKinds(can);
  return REQUESTS.filter((r) => kinds.includes(r.id));
};

const tasksOf = (repo: string | null) => formatRoute({ repo, task: null, run: null });
const boardOf = (repo: string | null) =>
  formatRoute({ repo, task: null, run: null, page: "board" });
const allTasks = formatRoute({ repo: null, task: null, run: null, page: "tasks" });
const chatsOf = (repo: string | null) =>
  formatRoute({ repo, task: null, run: null, page: "chats" });
const onTasks = (route: Route) => route.page === "tasks" || (!route.page && !!route.repo);

// A repository's link: its board from a board, its chats from chats, else its tasks. All's:
// every repository's chats from chats, its tasks from All's tasks, else the Overview.
const repoHref = (route: Route, repo: string | null) => {
  if (route.page === "chats") return chatsOf(repo);
  if (!repo) return route.page === "tasks" && !route.repo ? allTasks : tasksOf(null);
  return route.page === "board" ? boardOf(repo) : tasksOf(repo);
};

interface Common {
  state: State | null;
  route: Route;
  // api/chats (App.tsx): the Chats link, with how many the user keeps of the most they may.
  chats?: Chats | null;
  // The services' health (api/health): a dot by Deckhand's name when one is down or starting.
  health?: Health | null;
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

// Chats: shown to a user who may start one somewhere (access.ts), or who keeps some.
const chatsShown = (can: Can, chats: Chats | null | undefined) =>
  !!chats && (can.anywhere("chat") || chats.chats.length > 0);

export function Sidebar(props: SidebarProps) {
  const { state, route, repos, rail, onRail, onRequest, notify, health = null } = props;
  const requests = menuRequests(useCan());
  const counts = repoCounts(state?.tasks ?? [], route.repo);
  const waiting = needingYou(repos?.repos ?? null, state?.tasks ?? []);
  const fold = t(rail ? "shell.expand" : "shell.collapse");
  const toggle = (
    <IconButton
      variant="ghost"
      size={rail ? "default" : "small"}
      class={rail ? "" : styles.collapse}
      label={fold}
      title={withKey(fold, "sidebar")}
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
        <HealthAlert health={health} class={rail ? styles.railAlert : undefined} />
        {!rail && toggle}
      </div>
      {state && requests.length > 0 && (
        <NewRequest onPick={onRequest} form={rail ? "icon" : "full"} />
      )}
      {rail && <span class={styles.rule} />}
      <RepoLinks counts={counts} route={route} rail={rail} />
      <div class={styles.bottom}>
        {repos && (
          <NavItem
            href={formatRoute({ repo: null, task: null, run: null, page: "settings" })}
            icon={<Icon.Settings size={rail ? 17 : 16} />}
            label={t("shell.settings")}
            current={route.page === "settings"}
            count={waiting}
            title={withKey(
              waiting ? t("shell.settingsWaiting", { count: waiting }) : t("shell.settings"),
              "settings",
            )}
            rail={rail}
          />
        )}
        {notify.permission === "default" && (
          <NavItem
            onClick={notify.ask}
            icon={<Icon.Bell size={rail ? 17 : 16} />}
            label={t("shell.notify")}
            title={t("shell.notifyHelp")}
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
    <nav
      class={`${styles.repos} ${touch ? styles.touch : ""}`}
      aria-label={t("shell.repositories")}
    >
      {!rail && !touch && <h2 class={styles.heading}>{t("shell.repositories")}</h2>}
      <NavItem
        href={repoHref(route, null)}
        icon={<Icon.Overview size={rail ? 17 : 16} />}
        label={t("shell.allRepositories")}
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
          title={c.live ? t("shell.repoRunning", { repo: c.repo, count: c.live }) : c.repo}
          current={shown && sameRepo(route.repo, c.repo)}
          count={c.input}
          hot
          rail={rail}
        />
      ))}
    </nav>
  );
}

// "2 of 4 running", a slot per run (a bar when there are many), the queue, and Sync. On the rail, the slots and Sync as an icon: what it did is in its title, and in the
// dashboard's note (App.tsx) for screen readers.
function RunSlots({
  state,
  error,
  syncer,
  rail,
}: Pick<SidebarProps, "state" | "error" | "syncer"> & { rail?: boolean }) {
  const { syncing, said, sync } = syncer;
  // Sync is server:sync's (access.ts).
  const syncs = useCan().server("server:sync");
  if (error) {
    const text = t("shell.unreachable", { error });
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
  if (!state) return rail ? null : <div class={styles.slots}>{t("shell.loading")}</div>;
  const { running, maxParallel: max, queued } = state;
  const summary = runningText(state);
  const rest = [t("slots.queued", { count: queued }), reservedText(state) ?? ""].filter(Boolean);
  const meter = (
    <Meter
      running={running}
      max={max}
      auto={state.autoPickup}
      rail={rail}
      title={[summary, ...rest].join(" · ")}
    />
  );
  const syncButton = syncs && (
    <IconButton
      variant="ghost"
      size={rail ? "default" : "small"}
      class={rail && said?.failed ? styles.railFailed : undefined}
      label={t("shell.sync")}
      icon={<Icon.Sync size={rail ? 17 : 15} />}
      pending={syncing}
      onClick={() => void sync()}
      title={rail && said ? said.text : t("shell.syncHelp")}
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
      <span class={styles.login} title={t("shell.signedIn", { user })}>
        @{user}
      </span>
      <ThemeSwitch class={styles.theme} />
      <form class={styles.logout} method="post" action="auth/logout">
        <IconButton
          type="submit"
          variant="ghost"
          size="small"
          label={t("shell.signOut")}
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
  const requests = menuRequests(useCan());
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
          {t("shell.newRequest")}
        </Button>
      ) : (
        <IconButton
          {...attrs}
          variant={form === "bar" ? "ghost" : "secondary"}
          size={form === "bar" ? "touch" : "default"}
          label={t("shell.newRequest")}
          title={withKey(t("shell.newRequest"), "request")}
          icon={<Icon.Plus size={form === "bar" ? 20 : 16} />}
        />
      )}
      {open && (
        <div
          class={styles.menu}
          role="menu"
          aria-label={t("shell.newRequest")}
          ref={menu}
          style={form === "icon" ? { top: `${at.top}px`, left: `${at.left}px` } : undefined}
        >
          {requests.map((r) => (
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
              {t(r.label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The page's title, its GitHub link, its views, the plans' usage and the page's own controls
// (`children`: the board's Start in); Settings' tabs under its title. `needs`: the repositories
// that need you, on the Repositories tab.
export function PageHeader({
  route,
  github,
  needs = 0,
  state = null,
  chats = null,
  children,
}: {
  route: Route;
  github: string;
  needs?: number;
  state?: State | null;
  // api/chats: Chats among the views, with how many the user keeps of the most they may.
  chats?: Chats | null;
  children?: ComponentChildren;
}) {
  const can = useCan();
  const settings = route.page === "settings";
  const chatting = route.page === "chats";
  const repo = settings ? null : route.repo;
  // The board is one repository's: All has the Overview instead.
  const views: Segment<"overview" | "tasks" | "board" | "chats">[] = repo
    ? [
        {
          value: "tasks",
          label: t("shell.tasks"),
          icon: <Icon.Tasks size={14} />,
          href: tasksOf(repo),
          title: withKey(t("shell.tasks"), "tasks"),
        },
        {
          value: "board",
          label: t("shell.board"),
          icon: <Icon.Board size={14} />,
          href: boardOf(repo),
          title: withKey(t("shell.board"), "board"),
        },
      ]
    : [
        {
          value: "overview",
          label: t("shell.overview"),
          icon: <Icon.Overview size={14} />,
          href: tasksOf(null),
          title: withKey(t("shell.overview"), "overview"),
        },
        {
          value: "tasks",
          label: t("shell.tasks"),
          icon: <Icon.Tasks size={14} />,
          href: allTasks,
          title: withKey(t("shell.tasks"), "tasks"),
        },
      ];
  // The user's chats on the repository shown, every repository's on All. How many they keep
  // counts them all: the limit is theirs, not a repository's.
  if (chatsShown(can, chats)) {
    views.push({
      value: "chats",
      label: t("shell.chats"),
      icon: <Icon.Talk size={14} />,
      href: chatsOf(repo),
      extra: (
        <span class={styles.kept} title={t("shell.chatsKeptHelp")}>
          {t("shell.chatsKept", { count: chats!.chats.length, limit: chats!.limit })}
        </span>
      ),
    });
  }
  const view = chatting
    ? "chats"
    : isOverview(route)
      ? "overview"
      : route.page === "board"
        ? "board"
        : "tasks";
  return (
    <header class={`${styles.header} ${settings ? styles.tabbed : ""}`}>
      <div class={styles.title}>
        <h1>{settings ? t("shell.settings") : (repo ?? t("shell.allRepositories"))}</h1>
        {repo && (
          <a
            class={styles.github}
            href={`${github}/${repo}`}
            target="_blank"
            rel="noreferrer"
            aria-label={t("shell.github", { repo })}
            title={t("shell.openGithub")}
          >
            <Icon.External size={14} />
          </a>
        )}
      </div>
      {settings && <SettingsTabs route={route} count={needs} class={styles.headerTabs} />}
      {!settings && <Segmented label={t("shell.view")} options={views} value={view} />}
      {!settings && !chatting && !repo && <span class={styles.hint}>{t("shell.boardHint")}</span>}
      {!chatting && repo && <RepoSlots state={state} repo={repo} />}
      {!settings && state && (
        <PlanBars plans={state.plans} now={state.now} form="compact" class={styles.headerPlans} />
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
  const { state, route, error, onRequest, onSearch, health = null } = props;
  const requests = menuRequests(useCan());
  const [sheet, setSheet] = useState(false);
  const settings = route.page === "settings";
  const shown = settings ? null : route.repo;
  const counts = repoCounts(state?.tasks ?? [], shown);
  const current = shown ? counts.repos.find((c) => sameRepo(c.repo, shown)) : null;
  const label = settings ? t("shell.settings") : (current?.repo ?? t("shell.allRepositories"));
  return (
    <>
      <header class={styles.topbar}>
        <button
          type="button"
          class={styles.switcher}
          aria-haspopup="dialog"
          aria-expanded={sheet}
          aria-label={t("shell.switchRepo", { label })}
          onClick={() => setSheet(true)}
        >
          {current && <StatusDot tone={current.live ? "run" : "idle"} pulse={current.moving} />}
          <span class={styles.switcherLabel}>{label}</span>
          <Icon.ChevronDown class={styles.chevron} />
        </button>
        <HealthAlert health={health} />
        {state && <PlanBars plans={state.plans} now={state.now} form="phone" />}
        {onSearch && (
          <IconButton
            variant="ghost"
            size="touch"
            label={t("shell.searchTasks")}
            icon={<Icon.Search size={20} />}
            onClick={onSearch}
          />
        )}
        {state && requests.length > 0 && <NewRequest onPick={onRequest} form="bar" />}
        {sheet && (
          <Sheet title={t("shell.repositories")} onClose={() => setSheet(false)}>
            <RepoLinks counts={counts} route={route} touch />
            <RunSlots {...props} />
            {state && <PlanBars plans={state.plans} now={state.now} class={styles.sheetPlans} />}
            {state && <User user={state.user} />}
          </Sheet>
        )}
      </header>
      {error && (
        <p class={styles.banner} role="alert">
          {t("shell.unreachable", { error })}
        </p>
      )}
    </>
  );
}

// The phone's tab bar. Tasks, Board and Chats are the repository shown, else the one last open
// here. Else Tasks and Chats are All's (and stay All's on either), and Board the most recently
// active repository's: the board is one repository's.
export function TabBar({ state, route, lastRepo, chats }: Common & { lastRepo: string | null }) {
  const can = useCan();
  const counts = repoCounts(state?.tasks ?? [], route.repo);
  const onAllTasks = route.page === "tasks" && !route.repo;
  const tasksRepo = route.repo ?? (onAllTasks ? null : lastRepo);
  const chatsRepo = route.repo ?? (route.page === "chats" || onAllTasks ? null : lastRepo);
  const repo = route.repo ?? lastRepo ?? counts.repos[0]?.repo ?? null;
  const tabs = [
    {
      id: "overview",
      label: t("shell.overview"),
      icon: <Icon.Overview size={22} />,
      href: tasksOf(null),
      current: isOverview(route),
      count: counts.all.input,
    },
    {
      id: "tasks",
      label: t("shell.tasks"),
      icon: <Icon.Tasks size={22} />,
      href: tasksRepo ? tasksOf(tasksRepo) : allTasks,
      current: onTasks(route),
    },
    {
      id: "board",
      label: t("shell.board"),
      icon: <Icon.Board size={22} />,
      href: repo ? boardOf(repo) : tasksOf(null),
      current: route.page === "board",
    },
    ...(chatsShown(can, chats)
      ? [
          {
            id: "chats",
            label: t("shell.chats"),
            icon: <Icon.Talk size={22} />,
            href: chatsOf(chatsRepo),
            current: route.page === "chats",
          },
        ]
      : []),
    {
      id: "settings",
      label: t("shell.settings"),
      icon: <Icon.Settings size={22} />,
      href: formatRoute({ repo: null, task: null, run: null, page: "settings" }),
      current: route.page === "settings",
    },
  ];
  return (
    <nav class={styles.tabbar} aria-label={t("shell.pages")}>
      {tabs.map((tab) => (
        <a
          key={tab.id}
          href={tab.href}
          aria-current={tab.current ? "page" : undefined}
          aria-label={
            tab.count ? t("shell.waitingOnYou", { label: tab.label, count: tab.count }) : undefined
          }
        >
          {tab.icon}
          {tab.label}
          {!!tab.count && (
            <span class={styles.pip} aria-hidden="true">
              {tab.count}
            </span>
          )}
        </a>
      ))}
    </nav>
  );
}
