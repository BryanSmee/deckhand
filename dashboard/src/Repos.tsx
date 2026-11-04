// Settings › Repositories: the repositories the App is installed on. While one isn't
// onboarded, a card explains onboarding in three steps and starts it on the first. Then the
// list, sorted by what needs you, filtered by name or by All / Needs you / Configured: each row
// with its flags (private, auto-merge), its status, one line of detail and one action (open a
// config with errors, answer an onboarding run's questions, start onboarding, enable issues,
// or the config). The footer says which Deckhand runs and since when (api/state's `server`).
// A repository's config opens in its place (ConfigPanel).
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { useCan } from "./access";
import type { RepoList } from "./api";
import { ConfigPanel } from "./ConfigPanel";
import { ago, isLive, plural, uptime, versionUrl } from "./format";
import { useNow } from "./hooks";
import { RepoBadge } from "./RepoBadge";
import { type ConfigTab, formatRoute } from "./route";
import type { AppLinks, Repo, RepoStatus, ServerInfo, Task } from "./types";
import { Button, buttonClass } from "./ui/Button";
import { Segmented } from "./ui/Choice";
import { Field } from "./ui/Field";
import { External, Search, Sync } from "./ui/icons";
import { Card } from "./ui/Surface";
import styles from "./Repos.module.css";

// The ones that need the maintainer first, then by name (the listener sorts by name).
const ORDER: RepoStatus[] = ["invalid", "not-onboarded", "onboarding", "unknown", "configured"];

// The onboarding issue's task, when the dashboard has it.
const onboardingTask = (r: Repo, tasks: Task[]) =>
  (r.issue && tasks.find((t) => t.repo === r.repo && t.number === r.issue!.number)) || null;

// An onboarding run asks: answer it. Its pull request: merge it. Ended any other way (failed,
// stopped, or done with no pull request): see why, and run it again from its page.
const asks = (task: Task | null) => task?.state === "needs-input";
const stalled = (task: Task | null) =>
  task !== null &&
  (["error", "interrupted", "cancelled"].includes(task.state) ||
    (task.state === "done" && !task.pr));

// What a maintainer has to do: fix a config, start onboarding (when it can be), or answer or
// rerun an onboarding run.
export function needsYou(r: Repo, tasks: Task[]): boolean {
  if (r.status === "invalid") return true;
  if (r.status === "not-onboarded") return r.issues;
  const task = r.status === "onboarding" ? onboardingTask(r, tasks) : null;
  return asks(task) || stalled(task);
}

export function needingYou(repos: Repo[] | null, tasks: Task[]): number {
  return repos?.filter((r) => needsYou(r, tasks)).length ?? 0;
}

const STALLED: Partial<Record<Task["state"], string>> = {
  error: "Its run failed: open it to run it again",
  interrupted: "Its run was interrupted: open it to run it again",
  cancelled: "Its run was stopped: open it to run it again",
};

// Adding or removing repositories: with a single installation, that installation's page;
// else GitHub's install page, which lists every account with Configure where it is installed.
export function reposUrl(app: AppLinks): string {
  return app.installations.length === 1 ? app.installations[0].url : app.installUrl;
}

type Show = "all" | "needs" | "configured";

interface Props {
  list: RepoList;
  // The repository whose config is open (null: the list).
  open?: string | null;
  // Its tab, when not Config.
  tab?: ConfigTab;
  onOpen?: (repo: string | null) => void;
  // api/state's tasks: an onboarding issue's questions.
  tasks?: Task[];
  // api/state's, and its clock: the uptime counts on it, refreshed with the state.
  server?: ServerInfo | null;
  serverNow?: number;
}

const configOf = (repo: string) =>
  formatRoute({ repo: null, task: null, run: null, page: "settings", config: repo });

// "Deckhand edge-1713fa6 · up 3 d 4 h · Node 26.1.0", the version linked to its code.
function Version({ server, now }: { server: ServerInfo; now: number }) {
  const url = versionUrl(server);
  return (
    <p class={styles.version}>
      Deckhand{" "}
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          {server.version}
        </a>
      ) : (
        server.version
      )}
      {" · "}
      <span title={`Since ${new Date(server.startedAt).toLocaleString()}`}>
        up {uptime(server.startedAt, now)}
      </span>
      {` · Node ${server.node.replace(/^v/, "")}`}
    </p>
  );
}

export function Repos({
  list,
  open = null,
  tab,
  onOpen = () => {},
  tasks = [],
  server = null,
  serverNow,
}: Props) {
  const { repos, app, listedAt, error, starting, failed, onboard } = list;
  const now = useNow();
  const [filter, setFilter] = useState("");
  const [show, setShow] = useState<Show>("all");
  // Where onboarding was started: its failure shows there, by the button that was clicked.
  const [from, setFrom] = useState<"card" | "row">("row");
  // What the user may do (access.ts): read a repo's config, onboard it (its config read and its
  // run started), list every installation again (server-wide, as Sync).
  const can = useCan();
  const onboards = (repo: string) =>
    can.repo(repo, "repo:config:read") && can.start(repo, "onboarding");
  if (open && !can.repo(open, "repo:config:read")) {
    return (
      <section aria-label={`${open} configuration`}>
        <p class={styles.empty}>
          {open}'s config isn't yours to read: you don't have <code>repo:config:read</code> there.{" "}
          <Button size="small" variant="ghost" onClick={() => onOpen(null)}>
            Back to the repositories
          </Button>
        </p>
      </section>
    );
  }
  if (open) {
    return (
      <section aria-label={`${open} configuration`}>
        <ConfigPanel
          repo={open}
          tab={tab}
          row={repos?.find((r) => r.repo === open) ?? null}
          onRow={list.update}
          onBack={() => onOpen(null)}
          now={now}
        />
      </section>
    );
  }
  const all = [...(repos ?? [])].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const needs = all.filter((r) => needsYou(r, tasks));
  const configured = all.filter((r) => r.status === "configured");
  const shown = (show === "needs" ? needs : show === "configured" ? configured : all).filter((r) =>
    r.repo.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const waiting = all.filter((r) => r.status === "not-onboarded");
  const first = waiting.find((r) => r.issues && onboards(r.repo));
  return (
    <div class={styles.page}>
      {waiting.length > 0 && (
        <Card as="section" class={styles.onboarding} aria-labelledby="onboarding-title">
          <div class={styles.onboardingHead}>
            <div class={styles.onboardingText}>
              <h2 id="onboarding-title">
                {waiting.length === 1
                  ? "1 repository isn't onboarded"
                  : `${waiting.length} repositories aren't onboarded`}
              </h2>
              <p>
                Onboarding writes its <code>.deckhand.yaml</code> with you. Until then, nothing runs
                there.
              </p>
            </div>
            {first && (
              <Button
                variant="primary"
                pending={starting === first.repo}
                pendingLabel="Starting…"
                disabled={starting !== null && starting !== first.repo}
                onClick={() => {
                  setFrom("card");
                  void onboard(first.repo);
                }}
              >
                Onboard {first.repo}
              </Button>
            )}
            {from === "card" && failed && (
              <p class={styles.failed} role="alert">
                Couldn't onboard {failed.repo}: {failed.error}
              </p>
            )}
          </div>
          <ol class={styles.steps} aria-label="Onboarding steps">
            <li>
              <span class={styles.num}>1</span>
              <span>
                <b>Start onboarding</b>
                <span>Deckhand opens an issue in the repository and starts a run on it.</span>
              </span>
            </li>
            <li>
              <span class={styles.num}>2</span>
              <span>
                <b>Answer its questions</b>
                <span>
                  The run reads the code, then asks what it can't guess: setup, tests, modes.
                </span>
              </span>
            </li>
            <li>
              <span class={styles.num}>3</span>
              <span>
                <b>Merge its pull request</b>
                <span>The config lands on the default branch; issues can start right away.</span>
              </span>
            </li>
          </ol>
        </Card>
      )}
      <Card as="section" class={styles.list} aria-labelledby="repos-title">
        <div class={styles.toolbar}>
          <h2 id="repos-title">Repositories</h2>
          <Field
            class={styles.filter}
            label="Filter repositories"
            hideLabel
            size="small"
            lead={<Search size={14} />}
            placeholder="Filter repositories"
            value={filter}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
          <Segmented
            label="Show"
            value={show}
            onChange={setShow}
            options={[
              {
                value: "all",
                label: "All",
                extra: <span class={styles.segCount}>{all.length}</span>,
              },
              {
                value: "needs",
                label: "Needs you",
                extra: <span class={styles.segCount}>{needs.length}</span>,
              },
              {
                value: "configured",
                label: "Configured",
                extra: <span class={styles.segCount}>{configured.length}</span>,
              },
            ]}
          />
          <span class={styles.tools}>
            {listedAt !== null && <span class={styles.read}>Listed {ago(listedAt, now)}</span>}
            {can.server("server:sync") && (
              <Button
                size="small"
                icon={<Sync size={14} />}
                pending={list.refreshing}
                onClick={list.refresh}
                title="List the installations' repositories and read every config again"
              >
                Refresh
              </Button>
            )}
            {app && (
              <a
                class={buttonClass("secondary", "small")}
                href={reposUrl(app)}
                target="_blank"
                rel="noreferrer"
                title={`Add or remove repositories on GitHub (${app.name})`}
              >
                Manage the App
                <External size={13} />
              </a>
            )}
          </span>
          {list.refreshError && (
            <p class={styles.failed} role="alert">
              Couldn't refresh ({list.refreshError})
            </p>
          )}
        </div>
        {error && <p class={styles.empty}>Can't list the repositories ({error}).</p>}
        {!repos && !error && <p class={styles.empty}>Loading…</p>}
        {repos?.length === 0 && (
          <p class={styles.empty}>
            The App isn't installed on any allowed repository yet.
            {app && (
              <>
                {" "}
                <a href={app.installUrl} target="_blank" rel="noreferrer">
                  Install the App on a repository
                </a>
              </>
            )}
          </p>
        )}
        {all.length > 0 && shown.length === 0 && (
          <p class={styles.empty}>No repository here{filter.trim() && " matches the filter"}.</p>
        )}
        {shown.length > 0 && (
          <ul class={styles.rows} aria-label="Repositories">
            {shown.map((r) => (
              <Row
                key={r.repo}
                r={r}
                list={list}
                task={onboardingTask(r, tasks)}
                now={now}
                onStart={() => setFrom("row")}
                failure={from === "row"}
              />
            ))}
          </ul>
        )}
      </Card>
      {server && <Version server={server} now={serverNow ?? now} />}
    </div>
  );
}

interface RowProps {
  r: Repo;
  list: RepoList;
  task: Task | null;
  now: number;
  onStart: () => void;
  // Its onboarding's failure shows here: it was started from this row.
  failure: boolean;
}

function Row({ r, list, task, now, onStart, failure }: RowProps) {
  const { starting, failed, onboard } = list;
  // Its config, and its onboarding (access.ts): none of their links without them.
  const can = useCan();
  const reads = can.repo(r.repo, "repo:config:read");
  const onboards = reads && can.start(r.repo, "onboarding");
  const config = (label: string, variant?: "primary") =>
    reads ? (
      <a class={small(variant)} href={configOf(r.repo)}>
        {label}
      </a>
    ) : null;
  const small = (variant: "primary" | "secondary" | "ghost" = "secondary") =>
    buttonClass(variant, "small");
  const [detail, action] = ((): [string, ComponentChildren] => {
    switch (r.status) {
      case "invalid":
        return [
          "Its .deckhand.yaml has errors: no run starts until they are fixed",
          config("Open config", "primary"),
        ];
      case "onboarding": {
        const n = task?.questions?.items?.length;
        const state = asks(task)
          ? n
            ? `${plural(n, "question")} ${n === 1 ? "is" : "are"} waiting for your answers`
            : "Its questions are waiting for your answers"
          : task && stalled(task)
            ? (STALLED[task.state] ?? "Its run ended with no pull request: open it to run it again")
            : task?.pr
              ? "Its pull request is open: merge it to finish"
              : task && isLive(task)
                ? "Its run reads the code and proposes a config"
                : task
                  ? "Its run waits for a free slot"
                  : "Its run reports on the issue";
        return [
          r.issue ? `Issue #${r.issue.number} · ${state}` : state,
          <>
            {r.issue && (
              <a
                class={small("ghost")}
                href={r.issue.url}
                target="_blank"
                rel="noreferrer"
                title={`The onboarding issue on GitHub`}
              >
                #{r.issue.number}
                <External size={12} />
              </a>
            )}
            {task && (asks(task) || stalled(task)) && (
              <a class={small()} href={formatRoute({ repo: task.repo, task: task.key, run: null })}>
                {asks(task) ? "Answer" : "Open run"}
              </a>
            )}
          </>,
        ];
      }
      case "not-onboarded":
        return r.issues
          ? [
              "No .deckhand.yaml on its default branch",
              onboards && (
                <Button
                  variant="primary"
                  size="small"
                  pending={starting === r.repo}
                  pendingLabel="Starting…"
                  disabled={starting !== null && starting !== r.repo}
                  onClick={() => {
                    onStart();
                    void onboard(r.repo);
                  }}
                >
                  Start onboarding
                </Button>
              ),
            ]
          : [
              "Its issues are disabled on GitHub, so it can't be onboarded",
              <a
                class={small()}
                href={`${r.url}/settings`}
                target="_blank"
                rel="noreferrer"
                title="Its settings on GitHub: Features › Issues"
              >
                Enable issues
                <External size={12} />
              </a>,
            ];
      case "unknown":
        return ["GitHub didn't answer: see the orchestrator's logs", config("Config")];
      default:
        return [r.readAt === null ? "Configured" : `Read ${ago(r.readAt, now)}`, config("Config")];
    }
  })();
  return (
    <li class={styles.row}>
      <span class={styles.name}>
        {reads ? (
          <a href={configOf(r.repo)} title={`${r.repo}: its config`}>
            {r.repo}
          </a>
        ) : (
          r.repo
        )}
        {r.private && <span class={styles.flag}>private</span>}
        {r.autoMerge && (
          <span
            class={`${styles.flag} ${styles.danger}`}
            title="Deckhand merges its own pull requests after its review: nobody reads them before they reach the default branch"
          >
            Auto-merge, no human review
          </span>
        )}
      </span>
      <span class={styles.status}>
        <RepoBadge status={r.status} />
      </span>
      <span class={styles.detail}>{detail}</span>
      <span class={styles.action}>{action}</span>
      {failure && failed?.repo === r.repo && (
        <p class={styles.failed} role="alert">
          {failed.error}
        </p>
      )}
    </li>
  );
}
