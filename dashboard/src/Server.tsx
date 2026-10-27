// Settings › Server (docs/design/reference/server.html): what this Deckhand is and how it is
// set up, read-only. The listener's status and version (api/state's `server`), its run slots
// and preview hooks (api/state), the engine, proxy, grants and access (api/server, read when
// the page opens), and the GitHub App (api/repos's `app`) with the last sync and Sync now.
import { Fragment } from "preact";
import { usePolled } from "./api";
import { ago, dayTime, plural, uptime, versionUrl } from "./format";
import { useSync, syncMessage } from "./Sync";
import type { AppLinks, Preview, ServerSetup, State, SyncResult } from "./types";
import { Button, buttonClass } from "./ui/Button";
import * as Icon from "./ui/icons";
import { Meter } from "./ui/Meter";
import { StatusBadge } from "./ui/Status";
import { Card } from "./ui/Surface";
import styles from "./Server.module.css";

interface Props {
  state: State | null;
  // Why api/state can't be read, if it can't.
  error?: string | null;
  app: AppLinks | null;
  // Reads api/state again: after Sync now, its last sync.
  refresh?: () => Promise<void>;
}

export function Server({ state, error = null, app, refresh }: Props) {
  const setup = usePolled<ServerSetup>("api/server", null);
  return (
    <div class={styles.page}>
      <Status state={state} error={error} />
      <Runs state={state} setup={setup.data} error={setup.error} />
      <Previews previews={state?.previews ?? []} now={state?.now ?? Date.now()} />
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
  return (
    <Card as="section" class={`${styles.status} ${tone}`} aria-labelledby="server-status">
      <span class={styles.statusIcon} aria-hidden="true">
        {down ? <Icon.Alert size={18} /> : server && <Icon.Check size={18} />}
      </span>
      <div class={styles.statusText}>
        <h2 id="server-status">
          {down ? "Can't reach the listener" : server ? "The listener is up" : "Loading…"}
        </h2>
        {down && <span class={styles.meta}>{error}</span>}
        {!down && server && state && (
          <span class={styles.meta}>
            Deckhand{" "}
            {url ? (
              <a class={styles.mono} href={url} target="_blank" rel="noreferrer">
                {server.version}
              </a>
            ) : (
              <span class={styles.mono}>{server.version}</span>
            )}
            {` · up ${uptime(server.startedAt, state.now)}, since ${dayTime(server.startedAt, state.now)}`}
            {` · Node ${server.node.replace(/^v/, "")}`}
            {server.source && (
              <>
                {" · built from "}
                <a class={styles.mono} href={server.source} target="_blank" rel="noreferrer">
                  {repoName(server.source)}
                </a>
              </>
            )}
          </span>
        )}
      </div>
      <span class={styles.note}>
        Its operator changes these in the server's environment and grants folder.
      </span>
    </Card>
  );
}

const ENGINES: Record<NonNullable<ServerSetup["engine"]>, string> = {
  sysbox: "Sysbox",
  podman: "Podman",
  auto: "Sysbox, else Podman",
};

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
  const unread = error ? `Couldn't read (${error})` : "…";
  const grants = setup?.grants;
  return (
    <Card as="section" aria-labelledby="server-runs">
      <div class={styles.head}>
        <h2 id="server-runs">Runs</h2>
        {state && <span class={styles.aside}>MAX_PARALLEL {state.maxParallel}</span>}
      </div>
      <div class={styles.facts}>
        <div class={styles.fact}>
          <span class={styles.label}>Slots</span>
          {state && (
            <Meter running={state.running} max={state.maxParallel} large class={styles.meter} />
          )}
          <span class={styles.value}>
            {state ? `${state.running} running · ${state.queued} queued` : "…"}
          </span>
        </div>
        <div class={styles.fact}>
          <span class={styles.label}>Container engine</span>
          <span class={styles.value}>
            {setup ? (setup.engine ? ENGINES[setup.engine] : "None") : unread}
          </span>
        </div>
        <div class={styles.fact}>
          <span class={styles.label}>Egress proxy</span>
          <span class={styles.value}>
            {setup
              ? [
                  setup.proxy.on ? "On" : "Off",
                  setup.proxy.hosts === null
                    ? "hosts not counted"
                    : `${plural(setup.proxy.hosts, "host")} granted`,
                ].join(" · ")
              : unread}
          </span>
        </div>
        <div class={styles.fact}>
          <span class={styles.label}>Grants folder</span>
          {grants ? (
            grants.ok ? (
              <span class={`${styles.value} ${styles.ok}`}>Read, no errors</span>
            ) : (
              <>
                <span class={`${styles.value} ${styles.bad}`}>
                  {grants.file ? (
                    <>
                      Errors in <span class={styles.mono}>{grants.file}</span>
                    </>
                  ) : (
                    "Errors"
                  )}
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

// The preview hooks waiting or running: a row each.
function Previews({ previews, now }: { previews: Preview[]; now: number }) {
  return (
    <Card as="section" aria-labelledby="server-previews">
      <div class={styles.head}>
        <h2 id="server-previews">Preview hooks</h2>
        <span class={styles.aside}>
          {previews.length ? `${previews.length} going on` : "None going on"}
        </span>
      </div>
      {previews.length > 0 && (
        <table class={styles.table}>
          <thead>
            <tr>
              <th scope="col">Container</th>
              <th scope="col">Repository</th>
              <th scope="col">Event</th>
              <th scope="col">State</th>
              <th scope="col">Since</th>
            </tr>
          </thead>
          <tbody>
            {previews.map((p) => (
              <tr key={p.name}>
                <td class={`${styles.mono} ${styles.cut}`} title={p.name}>
                  {p.name}
                </td>
                <td class={styles.mono}>{p.repo}</td>
                <td>{[p.event, p.action].filter(Boolean).join(" · ")}</td>
                <td>
                  {p.state === "running" ? (
                    <StatusBadge tone="run" pulse label="Running" />
                  ) : (
                    <StatusBadge tone="idle" label="Waiting" />
                  )}
                </td>
                <td class={styles.since} title={new Date(p.since).toLocaleString()}>
                  {uptime(p.since, now)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// "Last sync 12 min ago: 2 missed deliveries asked again, 1 pull request updated."
export function lastSyncLine(last: SyncResult | null, now: number): string {
  if (!last) return "No sync yet.";
  const when = `Last sync ${ago(last.at, now)}`;
  if (last.error) return `${when} failed: ${last.error}`;
  const said = syncMessage(last).replace(/^Synced: /, "");
  return `${when}: ${said.charAt(0).toLowerCase()}${said.slice(1)}.`;
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
  const link = buttonClass("secondary", "small");
  return (
    <Card as="section" aria-labelledby="server-app">
      <div class={styles.head}>
        <h2 id="server-app">GitHub App</h2>
        {app && (
          <span class={styles.links}>
            <a class={link} href={app.settingsUrl} target="_blank" rel="noreferrer">
              App settings
              <External />
            </a>
            <a class={link} href={app.installUrl} target="_blank" rel="noreferrer">
              Install on another account
              <External />
            </a>
          </span>
        )}
      </div>
      <dl class={styles.kv}>
        <div>
          <dt>Name</dt>
          <dd class={styles.mono}>{app?.name ?? "…"}</dd>
        </div>
        <div>
          <dt>Installed on</dt>
          <dd class={styles.wrap}>
            {app && !app.installations.length && "No account yet"}
            {app?.installations.map((i) => (
              <span key={i.url}>
                <span class={styles.mono}>{i.account ?? "An account"}</span>
                {" · "}
                <a href={i.url} target="_blank" rel="noreferrer">
                  configure ↗
                </a>
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt>Webhook deliveries</dt>
          <dd class={styles.wrap}>
            <span>{lastSyncLine(lastSync, now)}</span>
            <Button
              size="small"
              icon={<Icon.Sync size={14} />}
              pending={syncing}
              pendingLabel="Syncing…"
              onClick={() => void sync()}
              title="Ask GitHub again for the webhook deliveries it couldn't hand over, for the open pull requests' states, and whether they still merge"
            >
              Sync now
            </Button>
            {/* A recorded sync's failure is on the line already: only a refusal is said. */}
            {said?.failed && !said.recorded && (
              <span role="status" class={styles.bad}>
                {said.text}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Who can sign in</dt>
          <dd>
            {setup ? setup.allowedUsers.join(", ") : "…"}
            <span class={styles.env}> · ALLOWED_USERS</span>
          </dd>
        </div>
        <div>
          <dt>Allowed repositories</dt>
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
                : "Every repository the App is installed on"}
            <span class={styles.env}> · ALLOWED_REPOS</span>
          </dd>
        </div>
      </dl>
    </Card>
  );
}
