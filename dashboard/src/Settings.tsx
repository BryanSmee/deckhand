// Settings: its tabs (Repositories, Preferences, Server) and the one open. The tabs are links,
// so each has its address (route.ts); on a wide screen they sit in the page header, on a
// phone atop the page; a repository's config hides them for its own header. Preferences says
// it's coming until its page lands.
import type { RepoList } from "./api";
import type { Notify } from "./notify";
import { Preferences } from "./Preferences";
import { needingYou, Repos } from "./Repos";
import { formatRoute, type Route, type Section } from "./route";
import { Server } from "./Server";
import type { State } from "./types";
import { Count } from "./ui/Count";
import tabs from "./ui/Tabs.module.css";
import styles from "./Settings.module.css";

const TABS: { id: Section | null; label: string }[] = [
  { id: null, label: "Repositories" },
  { id: "preferences", label: "Preferences" },
  { id: "server", label: "Server" },
];

// Repositories' count: those that need you (Repos.tsx needsYou()).
export function SettingsTabs({
  route,
  count,
  class: extra,
}: {
  route: Route;
  count: number;
  class?: string;
}) {
  const current = route.section ?? null;
  return (
    <nav class={[tabs.tabs, extra].filter(Boolean).join(" ")} aria-label="Settings">
      {TABS.map((t) => (
        <a
          key={t.label}
          class={tabs.tab}
          href={formatRoute({
            repo: null,
            task: null,
            run: null,
            page: "settings",
            ...(t.id ? { section: t.id } : {}),
          })}
          aria-current={t.id === current ? "page" : undefined}
        >
          {t.label}
          {!t.id && count > 0 && <Count n={count} hot />}
        </a>
      ))}
    </nav>
  );
}

interface Props {
  route: Route;
  state: State | null;
  // Why api/state can't be read, if it can't.
  error?: string | null;
  repos: RepoList;
  // A phone: the tabs are the page's own.
  narrow: boolean;
  notify: Notify;
  onOpen: (repo: string | null) => void;
  // Reads api/state again (Server's Sync now).
  refresh?: () => Promise<void>;
}

export function Settings({ route, state, error, repos, narrow, notify, onOpen, refresh }: Props) {
  const tasks = state?.tasks ?? [];
  return (
    <div class={styles.settings}>
      {narrow && !route.config && (
        <SettingsTabs route={route} count={needingYou(repos.repos, tasks)} class={styles.tabs} />
      )}
      {route.section === "server" ? (
        <Server state={state} error={error} app={repos.app} refresh={refresh} />
      ) : route.section === "preferences" ? (
        <Preferences notify={notify} user={state?.user} />
      ) : (
        <Repos
          list={repos}
          open={route.config ?? null}
          tab={route.configTab}
          onOpen={onOpen}
          tasks={tasks}
          server={state?.server}
          serverNow={state?.now}
        />
      )}
    </div>
  );
}
