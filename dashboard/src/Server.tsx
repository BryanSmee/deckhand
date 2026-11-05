// Settings › Server (docs/design/dashboard-redesign.md › Pages › Settings › Server): what this
// Deckhand is and how it is set up, read-only. The listener's status and version (api/state's
// `server`), the services' health under it (api/health, Health.tsx), its run slots (api/state),
// the engine, proxy, grants and access
// (api/server, read when the page opens), and the GitHub App (api/repos's `app`) with the last sync
// and Sync now.
import { Fragment } from "preact";
import { useCan } from "./access";
import { usePolled } from "./api";
import { ago, AUTH_NAMES, dayTime, reservedText, uptime, versionUrl } from "./format";
import { Services } from "./Health";
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
import { useSync } from "./Sync";
import type { AppLinks, Auth, Health, ServerSetup, State, SyncResult } from "./types";
import { Button, buttonClass } from "./ui/Button";
import * as Icon from "./ui/icons";
import { Meter } from "./ui/Meter";
import { PlanBars } from "./ui/PlanUsage";
import { Card } from "./ui/Surface";
import styles from "./Server.module.css";

interface Props {
  state: State | null;
  // Why api/state can't be read, if it can't.
  error?: string | null;
  app: AppLinks | null;
  // Reads api/state again: after Sync now, its last sync.
  refresh?: () => Promise<void>;
  // api/health, which the shell polls (every 15 s while this page is open), and why it can't.
  health?: Health | null;
  healthError?: string | null;
  // A phone: the services as a list.
  narrow?: boolean;
}

export function Server({
  state,
  error = null,
  app,
  refresh,
  health = null,
  healthError = null,
  narrow = false,
}: Props) {
  const setup = usePolled<ServerSetup>("api/server", null);
  return (
    <div class={styles.page}>
      <Status state={state} error={error} />
      <Services health={health} error={healthError} narrow={narrow} />
      <Runs state={state} setup={setup.data} error={setup.error} />
      <App
        app={app}
        setup={setup.data}
        lastSync={state?.lastSync ?? null}
        now={state?.now ?? Date.now()}
        refresh={refresh}
      />
    </div>
  );
}

const External = () => <Icon.External size={13} />;

// "https://github.com/acme/deckhand" → "acme/deckhand".
const repoName = (url: string) => url.replace(/^[a-z]+:\/\/[^/]+\//i, "").replace(/\/$/, "");

// "The listener is up", with its version, uptime, Node and source; or that it can't be read.
// Before api/state's first answer, neutral: it isn't known to be up yet.
function Status({ state, error }: { state: State | null; error: string | null }) {
  const down = Boolean(error);
  const server = state?.server;
  const url = server && versionUrl(server);
  const tone = down ? "s-err" : server ? "s-done" : "s-idle";
  // What the line says of it, with or without the repository it was built from.
  const facts = server &&
    state && {
      version: url ? (
        <a class={styles.mono} href={url} target="_blank" rel="noreferrer">
          {server.version}
        </a>
      ) : (
        <span class={styles.mono}>{server.version}</span>
      ),
      uptime: uptime(server.startedAt, state.now),
      since: dayTime(server.startedAt, state.now),
      node: server.node.replace(/^v/, ""),
    };
  return (
    <Card as="section" class={`${styles.status} ${tone}`} aria-labelledby="server-status">
      <span class={styles.statusIcon} aria-hidden="true">
        {down ? <Icon.Alert size={18} /> : server && <Icon.Check size={18} />}
      </span>
      <div class={styles.statusText}>
        <h2 id="server-status">
          {t(down ? "server.unreachable" : server ? "server.up" : "server.loading")}
        </h2>
        {down && <span class={styles.meta}>{error}</span>}
        {!down && server && facts && (
          <span class={styles.meta}>
            {server.source
              ? tx("server.versionFrom", {
                  ...facts,
                  repo: (
                    <a class={styles.mono} href={server.source} target="_blank" rel="noreferrer">
                      {repoName(server.source)}
                    </a>
                  ),
                })
              : tx("server.version", facts)}
          </span>
        )}
      </div>
      <span class={styles.note}>{t("server.operatorNote")}</span>
    </Card>
  );
}

// Keys, written when shown.
const ENGINES: Record<NonNullable<ServerSetup["engine"]>, Plain> = {
  sysbox: "server.engineSysbox",
  podman: "server.enginePodman",
  auto: "server.engineAuto",
};

// Which Claude credential runs use unless they name one, then those FALLBACKS names
// (`claude@anthropic:key`), then the others set, which only `/agent` names: "Plan first, then
// API key as fallback", "Plan · API key also set".
function claudeText({ set, default: first, fallbacks = [] }: NonNullable<ServerSetup["claude"]>) {
  if (!first) return t("server.noCredential");
  const names = (auths: Auth[]) => auths.map((a) => t(AUTH_NAMES[a].label)).join(t("list.comma"));
  const after = fallbacks.filter((a) => a !== first);
  const others = set.filter((a) => a !== first && !after.includes(a));
  const label = t(AUTH_NAMES[first].label);
  return [
    after.length ? t("server.credentialFallback", { label, fallbacks: names(after) }) : label,
    ...(others.length ? [t("server.credentialsAlso", { names: names(others) })] : []),
  ].join(" · ");
}

// The slots, the container engine, the egress proxy and the grants folder.
function Runs({
  state,
  setup,
  error,
}: {
  state: State | null;
  setup: ServerSetup | null;
  error: string | null;
}) {
  // Not read yet: a dash; its read failed: why.
  const unread = error ? t("server.unread", { error }) : "…";
  const grants = setup?.grants;
  return (
    <Card as="section" aria-labelledby="server-runs">
      <div class={styles.head}>
        <h2 id="server-runs">{t("server.runs")}</h2>
        {state && <span class={styles.aside}>MAX_PARALLEL {state.maxParallel}</span>}
      </div>
      <div class={styles.facts}>
        <div class={styles.fact}>
          <span class={styles.label}>{t("server.slots")}</span>
          {state && (
            <Meter
              running={state.running}
              max={state.maxParallel}
              auto={state.autoPickup}
              large
              class={styles.meter}
            />
          )}
          <span class={styles.value}>
            {state
              ? [
                  t("server.running", { count: state.running }),
                  t("slots.queued", { count: state.queued }),
                  reservedText(state),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "…"}
          </span>
        </div>
        {state?.plans?.some((p) => p.windows.length) && (
          <div class={styles.fact}>
            <span class={styles.label}>{t("server.plans")}</span>
            <PlanBars plans={state.plans} now={state.now} class={styles.plans} />
          </div>
        )}
        <div class={styles.fact}>
          <span class={styles.label}>{t("server.engine")}</span>
          <span class={styles.value}>
            {setup ? t(setup.engine ? ENGINES[setup.engine] : "server.engineNone") : unread}
          </span>
        </div>
        {(!setup || setup.claude) && (
          <div class={styles.fact}>
            <span class={styles.label}>Claude</span>
            <span class={styles.value}>{setup?.claude ? claudeText(setup.claude) : unread}</span>
            {setup?.claude?.default && (
              <span class={`${styles.small} ${styles.mono}`}>
                {AUTH_NAMES[setup.claude.default].variable}
              </span>
            )}
          </div>
        )}
        <div class={styles.fact}>
          <span class={styles.label}>{t("server.proxy")}</span>
          <span class={styles.value}>
            {setup
              ? [
                  t(setup.proxy.on ? "server.proxyOn" : "server.proxyOff"),
                  setup.proxy.hosts === null
                    ? t("server.hostsUncounted")
                    : t("server.hosts", { count: setup.proxy.hosts }),
                ].join(" · ")
              : unread}
          </span>
        </div>
        <div class={styles.fact}>
          <span class={styles.label}>{t("server.grants")}</span>
          {grants ? (
            grants.ok ? (
              <span class={`${styles.value} ${styles.ok}`}>{t("server.grantsOk")}</span>
            ) : (
              <>
                <span class={`${styles.value} ${styles.bad}`}>
                  {grants.file
                    ? tx("server.grantsErrorsIn", {
                        file: <span class={styles.mono}>{grants.file}</span>,
                      })
                    : t("server.grantsErrors")}
                </span>
                {grants.message && <span class={styles.small}>{grants.message}</span>}
              </>
            )
          ) : (
            <span class={styles.value}>{unread}</span>
          )}
        </div>
      </div>
    </Card>
  );
}

// "Last sync 12 min ago: 2 missed deliveries asked again, 1 pull request updated."
// What it did as Sync.tsx's syncMessage() says it, its counts in its keys, but as a clause of
// this sentence rather than one of its own.
export function lastSyncLine(last: SyncResult | null, now: number): string {
  if (!last) return t("server.noSync");
  const when = ago(last.at, now);
  if (last.error) return t("server.syncFailed", { when, error: last.error });
  const { redelivered, pulls, conflicts } = last;
  if (!redelivered && !pulls && !conflicts) return t("server.syncUpToDate", { when });
  const done = [
    redelivered && t("sync.redelivered", { count: redelivered }),
    pulls && t("sync.pulls", { count: pulls }),
    conflicts && t("sync.conflicts", { count: conflicts }),
  ].filter(Boolean);
  return t("server.synced", { when, done: done.join(t("list.comma")) });
}

// The App, where it is installed, the webhook deliveries and who and what it lets in.
function App({
  app,
  setup,
  lastSync,
  now,
  refresh,
}: {
  app: AppLinks | null;
  setup: ServerSetup | null;
  lastSync: SyncResult | null;
  now: number;
  refresh?: () => Promise<void>;
}) {
  const { syncing, said, sync } = useSync(refresh);
  // Sync is server:sync's (access.ts).
  const syncs = useCan().server("server:sync");
  const link = buttonClass("secondary", "small");
  return (
    <Card as="section" aria-labelledby="server-app">
      <div class={styles.head}>
        <h2 id="server-app">{t("server.app")}</h2>
        {app && (
          <span class={styles.links}>
            <a class={link} href={app.settingsUrl} target="_blank" rel="noreferrer">
              {t("server.appSettings")}
              <External />
            </a>
            <a class={link} href={app.installUrl} target="_blank" rel="noreferrer">
              {t("server.install")}
              <External />
            </a>
          </span>
        )}
      </div>
      <dl class={styles.kv}>
        <div>
          <dt>{t("server.name")}</dt>
          <dd class={styles.mono}>{app?.name ?? "…"}</dd>
        </div>
        <div>
          <dt>{t("server.installedOn")}</dt>
          <dd class={styles.wrap}>
            {app && !app.installations.length && t("server.noAccount")}
            {app?.installations.map((i) => (
              <span key={i.url}>
                <span class={styles.mono}>{i.account ?? t("server.anAccount")}</span>
                {" · "}
                {i.missing.length > 0 && (
                  <>
                    <span class={styles.bad}>
                      {t("server.lacks", { missing: i.missing.join(t("list.comma")) })}
                    </span>
                    {" · "}
                  </>
                )}
                <a href={i.url} target="_blank" rel="noreferrer">
                  {t(i.missing.length > 0 ? "server.acceptPermissions" : "server.configure")}
                </a>
              </span>
            ))}
          </dd>
        </div>
        {app && (app.missingPermissions.length > 0 || app.missingEvents.length > 0) && (
          <div>
            <dt>{t("server.missing")}</dt>
            <dd class={styles.wrap}>
              {app.missingPermissions.length > 0 && (
                <span>
                  <span class={styles.bad}>
                    {t("server.missingPermissions", {
                      count: app.missingPermissions.length,
                      names: app.missingPermissions.join(t("list.comma")),
                    })}
                  </span>
                  {" · "}
                  {t("server.addPermissions", { count: app.missingPermissions.length })}
                </span>
              )}
              {app.missingEvents.length > 0 && (
                <span>
                  <span class={styles.bad}>
                    {t("server.missingEvents", {
                      count: app.missingEvents.length,
                      names: app.missingEvents.join(t("list.comma")),
                    })}
                  </span>
                  {" · "}
                  {t("server.addEvents", { count: app.missingEvents.length })}
                </span>
              )}
              <a href={app.settingsUrl} target="_blank" rel="noreferrer">
                {t("server.appSettingsLink")}
              </a>
            </dd>
          </div>
        )}
        <div>
          <dt>{t("server.deliveries")}</dt>
          <dd class={styles.wrap}>
            <span>{lastSyncLine(lastSync, now)}</span>
            {syncs && (
              <Button
                size="small"
                icon={<Icon.Sync size={14} />}
                pending={syncing}
                pendingLabel={t("server.syncing")}
                onClick={() => void sync()}
                title={t("server.syncHelp")}
              >
                {t("server.sync")}
              </Button>
            )}
            {/* A recorded sync's failure is on the line already: only a refusal is said. */}
            {said?.failed && !said.recorded && (
              <span role="status" class={styles.bad}>
                {said.text}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("server.users")}</dt>
          <dd>
            {setup ? setup.allowedUsers.join(t("list.comma")) : "…"}
            <span class={styles.env}> · ALLOWED_USERS</span>
          </dd>
        </div>
        <div>
          <dt>{t("server.repos")}</dt>
          <dd>
            {!setup
              ? "…"
              : setup.allowedRepos.length
                ? setup.allowedRepos.map((r, i) => (
                    <Fragment key={r}>
                      {i > 0 && ", "}
                      <span class={styles.mono}>{r}</span>
                    </Fragment>
                  ))
                : t("server.everyRepo")}
            <span class={styles.env}> · ALLOWED_REPOS</span>
          </dd>
        </div>
      </dl>
    </Card>
  );
}
