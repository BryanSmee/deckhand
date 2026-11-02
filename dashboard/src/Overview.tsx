// All repositories' page (docs/design/dashboard-redesign.md › Pages › Overview): the totals
// (running, waiting on you, ready for review, failed), each a link to All's tasks under its
// chip; what waits on you across repositories, oldest first, with one action per row; and a
// card per repository: its config's status, its tasks by state, its backlog and lanes, and
// Open board, or Onboard for one that isn't onboarded.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { type RepoList, sendDismiss, sendRerun } from "./api";
import {
  type ChipId,
  findingsLeft,
  reviewOutdated,
  githubUrl,
  heldText,
  inChip,
  issueList,
  numberOf,
  plural,
  repoTabs,
  sameRepo,
  titleOf,
  type Tone,
} from "./format";
import {
  age,
  backlogLine,
  laneCount,
  type Need,
  repoParts,
  type Waiting,
  waitingOnYou,
} from "./overview";
import { CiStatus } from "./CiStatus";
import { Questions } from "./Questions";
import { ReviewMarks } from "./ReviewLoop";
import { RepoBadge } from "./RepoBadge";
import { formatRoute } from "./route";
import type { Repo, State, Task } from "./types";
import { Button, buttonClass } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { StatusBadge, StatusDot, toneClass } from "./ui/Status";
import { Card, Notice, Skeleton } from "./ui/Surface";
import styles from "./Overview.module.css";

interface Props {
  state: State | null;
  // api/repos?backlog=1: each repository's status and backlog; absent, the tasks' repos alone.
  repos?: RepoList;
  github: string;
  // All's tasks open under this chip (a total's link).
  onChip: (chip: ChipId) => void;
  // Reads api/state again (answers sent, a rerun queued).
  refresh?: () => Promise<void>;
}

const allTasks = formatRoute({ repo: null, task: null, run: null, page: "tasks" });
const taskHref = (t: Task) => formatRoute({ repo: t.repo, task: t.key, run: null });

export function Overview({ state, repos, github, onChip, refresh }: Props) {
  if (!state) {
    return (
      <div class={styles.page} aria-busy="true">
        <div class={styles.tiles}>
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} class={styles.tile}>
              <Skeleton width="50%" />
              <Skeleton width="30%" height={28} />
            </Card>
          ))}
        </div>
      </div>
    );
  }
  const rows = waitingOnYou(state.tasks);
  return (
    <div class={styles.page}>
      <Totals state={state} onChip={onChip} />
      <WaitingOnYou rows={rows} now={state.now} github={github} refresh={refresh} />
      <RepoCards state={state} repos={repos} />
    </div>
  );
}

function Tile(props: {
  tone: Tone;
  label: string;
  count: number;
  meta: string;
  chip: ChipId;
  pulse?: boolean;
  onChip: (chip: ChipId) => void;
}) {
  const { tone, label, count, meta, chip, pulse, onChip } = props;
  return (
    <a
      href={allTasks}
      class={`${styles.tile} ${toneClass(tone)}`}
      onClick={() => onChip(chip)}
      aria-label={`${label}: ${count}, ${meta}`}
    >
      <span class={styles.tileLabel}>
        <StatusDot tone={tone} pulse={pulse} />
        {label}
      </span>
      <span class={styles.tileCount}>{count}</span>
      <span class={styles.tileMeta}>{meta}</span>
    </a>
  );
}

// Each total counts what its chip lists, and says what is in it.
function Totals({ state, onChip }: { state: State; onChip: (chip: ChipId) => void }) {
  const of = (chip: ChipId) => state.tasks.filter((t) => inChip(chip, t));
  const asking = of("input");
  const count = (state: Task["state"]) => asking.filter((t) => t.state === state).length;
  const ready = of("review");
  const failed = of("error");
  const rerunnable = failed.filter((t) => t.rerunnable).length;
  const numbers = ready.flatMap((t) => (t.pr ? [t.pr.number] : []));
  return (
    <div class={styles.tiles}>
      <Tile
        tone="run"
        label="Running"
        count={state.running}
        meta={[
          `of ${plural(state.maxParallel, "slot")}`,
          state.autoPickup && `${state.autoPickup.running} auto-picked`,
          heldText(state),
          `${state.queued} queued`,
        ]
          .filter(Boolean)
          .join(" · ")}
        chip="running"
        pulse={state.running > 0}
        onChip={onChip}
      />
      <Tile
        tone="input"
        label="Needs you"
        count={asking.length}
        meta={
          [
            [count("needs-input"), "question"],
            [count("brainstorm"), "brainstorm turn"],
            [count("idle-brainstorm"), "idle brainstorm"],
          ]
            .filter(([n]) => n)
            .map(([n, what]) => plural(n as number, what as string))
            .join(" · ") || "nothing asks"
        }
        chip="input"
        onChip={onChip}
      />
      <Tile
        tone="ready"
        label="Ready for review"
        count={ready.length}
        meta={
          !ready.length
            ? "nothing to review"
            : numbers.length <= 3
              ? `${numbers.length === 1 ? "pull request" : "pull requests"} ${issueList(numbers)}`
              : plural(ready.length, "pull request")
        }
        chip="review"
        onChip={onChip}
      />
      <Tile
        tone="err"
        label="Failed"
        count={failed.length}
        meta={
          !failed.length
            ? "nothing failed"
            : rerunnable === failed.length
              ? "can be rerun"
              : `${rerunnable} can be rerun`
        }
        chip="error"
        onChip={onChip}
      />
    </div>
  );
}

const BADGES: Record<Need, { label: string; action: string }> = {
  input: { label: "Needs input", action: "Answer" },
  turn: { label: "Your turn", action: "Reply" },
  ready: { label: "Ready for review", action: "Review PR" },
  error: { label: "", action: "Rerun" },
};

function WaitingOnYou({
  rows,
  now,
  github,
  refresh,
}: {
  rows: Waiting[];
  now: number;
  github: string;
  refresh?: () => Promise<void>;
}) {
  // The task whose questions are open, the rerun or dismissal on its way, and what the
  // listener said last.
  const [answering, setAnswering] = useState<Task | null>(null);
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; error?: boolean } | null>(null);
  const rerun = async (t: Task) => {
    setRerunning(t.key);
    setSaid(null);
    const answer = await sendRerun(t.repo, t.runs[0].id);
    const name = `${numberOf(t) || titleOf(t)} (${t.repo})`;
    setSaid({
      text: answer.error ?? `Rerun of ${name} queued.`,
      error: !!answer.error,
    });
    if (!answer.error) await refresh?.();
    setRerunning(null);
  };
  const dismiss = async (t: Task) => {
    setDismissing(t.key);
    setSaid(null);
    const answer = await sendDismiss(t.repo, t.runs[0].id);
    const name = `${numberOf(t) || titleOf(t)} (${t.repo})`;
    setSaid({
      text: answer.error ?? `${name} dismissed: its task page can undo it.`,
      error: !!answer.error,
    });
    if (!answer.error) await refresh?.();
    setDismissing(null);
  };

  // A failed run's row: its action, then Dismiss, which stops it asking.
  const actions = (row: Waiting): ComponentChildren => {
    const t = row.task;
    if (row.need !== "error" || !t.runs[0]) return action(row, styles.action);
    return (
      <span class={styles.actions}>
        {action(row)}
        <Button
          size="small"
          variant="ghost"
          pending={dismissing === t.key}
          pendingLabel="Dismissing…"
          title="It stops waiting on you until another run; its task page can undo it"
          onClick={() => void dismiss(t)}
        >
          Dismiss
        </Button>
      </span>
    );
  };

  // The task page's own action: its questions' form, a brainstorm's thread (on GitHub, or the
  // dashboard's for a discussion), the pull request, Rerun; else the task page. `place`: its
  // class in the row, when it has the row's action column to itself.
  const action = ({ task: t, need }: Waiting, place?: string): ComponentChildren => {
    const label = BADGES[need].action;
    const link = (href: string, text: string, outside = true) => (
      <a
        class={buttonClass("secondary", "small", place)}
        href={href}
        {...(outside ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {text}
      </a>
    );
    const page = taskHref(t);
    const issue = githubUrl(t, github);
    if (need === "input") {
      if (t.questions)
        return (
          <Button size="small" class={place} onClick={() => setAnswering(t)}>
            {label}
          </Button>
        );
      return issue ? link(issue, label) : link(page, label, false);
    }
    if (need === "turn")
      return t.kind === "discussion" || !issue ? link(page, label, false) : link(issue, label);
    if (need === "ready" && t.pr) return link(t.pr.url, label);
    if (need === "error" && t.rerunnable && t.runs[0])
      return (
        <Button
          size="small"
          class={place}
          pending={rerunning === t.key}
          pendingLabel="Rerunning…"
          title="Runs it again with the same comments and mode"
          onClick={() => void rerun(t)}
        >
          {label}
        </Button>
      );
    return link(page, "Open", false);
  };

  return (
    <Card as="section" class={styles.needs} aria-labelledby="waiting-on-you">
      <div class={styles.needsHead}>
        <h2 id="waiting-on-you" class={styles.section}>
          Waiting on you
        </h2>
        {rows.length > 1 && <span class={styles.meta}>Oldest first</span>}
      </div>
      {said && (
        <Notice tone={said.error ? "err" : "done"} class={styles.said}>
          {said.text}
        </Notice>
      )}
      {rows.length ? (
        <ul class={styles.rows}>
          {rows.map((row) => {
            const t = row.task;
            return (
              <li
                key={t.key}
                class={`${styles.need} ${row.need === "ready" && (findingsLeft(t) || reviewOutdated(t)) ? styles.warned : ""}`}
              >
                <StatusBadge
                  class={styles.badge}
                  state={t.state}
                  tone={row.need === "ready" ? "ready" : undefined}
                  label={BADGES[row.need].label || undefined}
                />
                <span class={styles.titleCell}>
                  <a class={styles.needTitle} href={taskHref(t)}>
                    {/* Without a title, titleOf() says the number already. */}
                    {t.title && t.number !== null && (
                      <span class={styles.number}>{numberOf(t)} </span>
                    )}
                    {titleOf(t)}
                  </a>
                  {/* Where you decide what to review: its pull request's CI. */}
                  {row.need === "ready" && t.pr && <CiStatus pr={t.pr} link />}
                </span>
                {row.need === "ready" && <ReviewMarks task={t} class={styles.left} />}
                <span class={styles.needRepo}>{t.repo}</span>
                <span class={styles.age} title={new Date(row.at).toLocaleString()}>
                  {age(row.at, now)}
                </span>
                {actions(row)}
              </li>
            );
          })}
        </ul>
      ) : (
        <p class={styles.empty}>Nothing waits on you.</p>
      )}
      {answering?.questions && (
        <Dialog
          title={`Answer ${numberOf(answering) || titleOf(answering)}`}
          sub={`${titleOf(answering)} · ${answering.repo}`}
          onClose={() => setAnswering(null)}
          wide
        >
          <Questions
            task={answering}
            questions={answering.questions}
            onSent={(message) => {
              setAnswering(null);
              setSaid({ text: message });
              void refresh?.();
            }}
          />
        </Dialog>
      )}
    </Card>
  );
}

// The repositories: the App's (api/repos) and those with tasks, in the sidebar's order
// (the most recently active first), then the others by name.
function RepoCards({ state, repos }: { state: State; repos?: RepoList }) {
  const active = repoTabs(state.tasks).map((t) => t.repo);
  const listed = repos?.repos ?? [];
  const names = [
    ...active,
    ...listed.map((r) => r.repo).filter((name) => !active.some((a) => sameRepo(a, name))),
  ];
  return (
    <section class={styles.repos} aria-labelledby="overview-repos">
      <h2 id="overview-repos" class={styles.section}>
        Repositories
      </h2>
      {repos?.error && !repos.repos && (
        <Notice tone="err">Can't list the repositories ({repos.error})</Notice>
      )}
      {names.length ? (
        <div class={styles.cards}>
          {names.map((name) => (
            <RepoCard
              key={name}
              name={name}
              state={state}
              row={listed.find((r) => sameRepo(r.repo, name)) ?? null}
              repos={repos}
            />
          ))}
        </div>
      ) : (
        <p class={styles.empty}>
          {repos && !repos.repos && !repos.error ? "Loading…" : "No repository yet."}
        </p>
      )}
    </section>
  );
}

function RepoCard({
  name,
  state,
  row,
  repos,
}: {
  name: string;
  state: State;
  row: Repo | null;
  repos?: RepoList;
}) {
  const tasks = state.tasks.filter((t) => sameRepo(t.repo, name));
  const parts = repoParts(tasks, state.now);
  const status = row?.status ?? null;
  const summary = parts.map((p) => p.words).join(" · ");
  const config = formatRoute({ repo: null, task: null, run: null, page: "settings", config: name });
  const board = formatRoute({ repo: name, task: null, run: null, page: "board" });
  const failed = repos?.failed?.repo === name ? repos.failed.error : null;

  let text: ComponentChildren = summary || "Nothing going on.";
  let foot: string | null = backlogLine(
    row?.backlog,
    laneCount(name, state.tasks, state.edges, state.blockers),
  );
  let main = (
    <a class={buttonClass("secondary", "small")} href={board}>
      Open board
    </a>
  );
  if (status === "not-onboarded") {
    text = row?.issues
      ? "Onboarding opens a run that proposes its .deckhand.yaml in a pull request."
      : "Its issues are turned off on GitHub: turn them on to onboard it.";
    foot = "No config yet";
    main = (
      <Button
        size="small"
        variant="primary"
        disabled={!row?.issues || !repos || (!!repos.starting && repos.starting !== name)}
        pending={repos?.starting === name}
        pendingLabel="Onboarding…"
        onClick={() => void repos?.onboard(name)}
      >
        Onboard
      </Button>
    );
  } else if (status === "onboarding" && row?.issue) {
    text = summary || `Its onboarding runs on issue #${row.issue.number}.`;
    foot = "Being onboarded";
    main = (
      <a
        class={buttonClass("secondary", "small")}
        href={row.issue.url}
        target="_blank"
        rel="noreferrer"
      >
        Open issue
      </a>
    );
  } else if (status === "invalid") {
    text = summary || "Its .deckhand.yaml has errors: no run starts until they are fixed.";
    main = (
      <a class={buttonClass("secondary", "small")} href={config}>
        See config
      </a>
    );
  }

  return (
    <Card as="article" class={styles.card}>
      <div class={styles.cardHead}>
        <h3 class={styles.repo}>
          <a href={formatRoute({ repo: name, task: null, run: null })}>{name}</a>
        </h3>
        {status && <RepoBadge status={status} />}
      </div>
      <span class={styles.bar} role="img" aria-label={summary || "No tasks"}>
        {parts.map((p) => (
          <span key={p.words} class={toneClass(p.tone)} style={{ flexGrow: p.count }} />
        ))}
      </span>
      <span class={styles.summary}>{text}</span>
      {failed && <Notice tone="err">{failed}</Notice>}
      <div class={styles.cardFoot}>
        <span class={styles.meta}>{foot}</span>
        {main}
      </div>
    </Card>
  );
}
