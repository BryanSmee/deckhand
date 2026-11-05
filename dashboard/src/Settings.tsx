// Settings: its tabs (Repositories, Preferences, MCP clients, Server, Access) and the one open.
// Server and Access are server:read's, left out without it (access.ts). The tabs
// are links, so each has its address (route.ts); on a wide screen they sit in the page header, on a
// phone atop the page; a repository's config hides them for its own header. Preferences says it's
// coming until its page lands.
import { Access } from "./Access";
import { useCan } from "./access";
import type { RepoList } from "./api";
import { Clients } from "./Clients";
import { t } from "./i18n";
import type { Plain } from "./locales";
import type { Notify } from "./notify";
import { Preferences } from "./Preferences";
import { needingYou, Repos } from "./Repos";
import { formatRoute, type Route, type Section } from "./route";
import { Server } from "./Server";
import type { Health, State } from "./types";
import { Count } from "./ui/Count";
import tabs from "./ui/Tabs.module.css";
import styles from "./Settings.module.css";

const TABS: { id: Section | null; label: Plain; server?: boolean }[] = [
  { id: null, label: "settings.repositories" },
  { id: "preferences", label: "settings.preferences" },
  { id: "clients", label: "settings.clients" },
  { id: "server", label: "settings.server", server: true },
  { id: "access", label: "settings.access", server: true },
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
  const reads = useCan().server("server:read");
  return (
    <nav class={[tabs.tabs, extra].filter(Boolean).join(" ")} aria-label={t("shell.settings")}>
      {TABS.filter((tab) => reads || !tab.server).map((tab) => (
        <a
          key={tab.label}
          class={tabs.tab}
          href={formatRoute({
            repo: null,
            task: null,
            run: null,
            page: "settings",
            ...(tab.id ? { section: tab.id } : {}),
          })}
          aria-current={tab.id === current ? "page" : undefined}
        >
          {t(tab.label)}
          {!tab.id && count > 0 && <Count n={count} hot />}
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
  // The services' health (api/health) and why it can't be read: Server's.
  health?: Health | null;
  healthError?: string | null;
}

export function Settings({
  route,
  state,
  error,
  repos,
  narrow,
  notify,
  onOpen,
  refresh,
  health,
  healthError,
}: Props) {
  const tasks = state?.tasks ?? [];
  const reads = useCan().server("server:read");
  const serverWide = route.section === "server" || route.section === "access";
  return (
    <div class={styles.settings}>
      {narrow && !route.config && (
        <SettingsTabs route={route} count={needingYou(repos.repos, tasks)} class={styles.tabs} />
      )}
      {serverWide && !reads ? (
        <p class={styles.refused}>
          This page isn't yours to see: it needs <code>server:read</code>, which the operator's
          policies give.
        </p>
      ) : route.section === "access" ? (
        <Access />
      ) : route.section === "server" ? (
        <Server
          state={state}
          error={error}
          app={repos.app}
          refresh={refresh}
          health={health}
          healthError={healthError}
          narrow={narrow}
        />
      ) : route.section === "clients" ? (
        <Clients />
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
