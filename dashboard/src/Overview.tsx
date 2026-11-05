// All repositories' page (docs/design/dashboard-redesign.md › Pages › Overview): the totals
// (running, waiting on you, ready for review, failed), each a link to All's tasks under its
// chip; what waits on you across repositories, oldest first, with one action per row; and a
// card per repository: its config's status, its tasks by state, its backlog and lanes, and
// Open board, or Onboard for one that isn't onboarded.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { useCan } from "./access";
import { type RepoList, sendDismiss, sendRerun } from "./api";
import {
  type ChipId,
  githubUrl,
  heldText,
  inChip,
  issueList,
  numberOf,
  readyStatus,
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
import { locale, t } from "./i18n";
import type { Plain } from "./locales";
import { Questions } from "./Questions";
import { ReviewMarks } from "./ReviewLoop";
import { RepoBadge } from "./RepoBadge";
import { RepoSlots } from "./RepoSlots";
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
  label: Plain;
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
      aria-label={t("overview.tile", { label: t(label), count, meta })}
    >
      <span class={styles.tileLabel}>
        <StatusDot tone={tone} pulse={pulse} />
        {t(label)}
      </span>
      <span class={styles.tileCount}>{count}</span>
      <span class={styles.tileMeta}>{meta}</span>
    </a>
  );
}

// Each total counts what its chip lists, and says what is in it.
function Totals({ state, onChip }: { state: State; onChip: (chip: ChipId) => void }) {
  const of = (chip: ChipId) => state.tasks.filter((task) => inChip(chip, task));
  const asking = of("input");
  const count = (state: Task["state"]) => asking.filter((task) => task.state === state).length;
  const ready = of("review");
  const failed = of("error");
  const rerunnable = failed.filter((task) => task.rerunnable).length;
  const numbers = ready.flatMap((task) => (task.pr ? [task.pr.number] : []));
  // Ready, but CI failed, a conflict, findings left or a review before the last push.
  const unclean = ready.filter((task) => readyStatus(task)?.tone === "input").length;
  return (
    <div class={styles.tiles}>
      <Tile
        tone="run"
        label="overview.running"
        count={state.running}
        meta={[
          t("overview.ofSlots", { count: state.maxParallel }),
          state.autoPickup && t("overview.autoPicked", { count: state.autoPickup.running }),
          heldText(state),
          t("overview.queued", { count: state.queued }),
        ]
          .filter(Boolean)
          .join(" · ")}
        chip="running"
        pulse={state.running > 0}
        onChip={onChip}
      />
      <Tile
        tone="input"
        label="overview.needsYou"
        count={asking.length}
        meta={
          (
            [
              ["overview.questions", count("needs-input")],
              ["overview.brainstormTurns", count("brainstorm")],
              ["overview.idleBrainstorms", count("idle-brainstorm")],
            ] as const
          )
            .filter(([, n]) => n)
            .map(([key, n]) => t(key, { count: n }))
            .join(" · ") || t("overview.nothingAsks")
        }
        chip="input"
        onChip={onChip}
      />
      {/* Purple though it counts the ones that aren't clean too: it counts what the Ready chip
          lists (every ready pull request whose loop is over, all waiting on the maintainer),
          and its meta says how many aren't clean; their rows below are amber. */}
      <Tile
        tone="ready"
        label="overview.readyForReview"
        count={ready.length}
        meta={[
          !ready.length
            ? t("overview.nothingToReview")
            : numbers.length <= 3
              ? t("overview.pullRequestList", { count: numbers.length, list: issueList(numbers) })
              : t("overview.pullRequests", { count: ready.length }),
          unclean && t("overview.notClean", { count: unclean }),
        ]
          .filter(Boolean)
          .join(" · ")}
        chip="review"
        onChip={onChip}
      />
      <Tile
        tone="err"
        label="overview.failed"
        count={failed.length}
        meta={
          !failed.length
            ? t("overview.nothingFailed")
            : rerunnable === failed.length
              ? t("overview.canBeRerun")
              : t("overview.someCanBeRerun", { count: rerunnable })
        }
        chip="error"
        onChip={onChip}
      />
    </div>
  );
}

// Keys: written at render, in the language then. A failed run's badge is its state's own.
const BADGES: Record<Need, { label?: Plain; action: Plain }> = {
  input: { label: "overview.needsInput", action: "overview.answer" },
  turn: { label: "overview.yourTurn", action: "overview.reply" },
  ready: { label: "overview.readyForReview", action: "overview.reviewPr" },
  error: { action: "overview.rerun" },
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
  // What the user may do on each task's repo (access.ts): answers, Rerun and Dismiss are
  // runs:manage, a rerun and a run's questions the start of the task's mode too.
  const can = useCan();
  const manages = (t: Task) => can.repo(t.repo, "runs:manage");
  const goesOn = (t: Task, mode: string | null | undefined) =>
    manages(t) && can.start(t.repo, mode || "work");
  const rerun = async (task: Task) => {
    setRerunning(task.key);
    setSaid(null);
    const answer = await sendRerun(task.repo, task.runs[0].id);
    const name = { task: numberOf(task) || titleOf(task), repo: task.repo };
    setSaid({
      text: answer.error ?? t("overview.rerunQueued", name),
      error: !!answer.error,
    });
    if (!answer.error) await refresh?.();
    setRerunning(null);
  };
  const dismiss = async (task: Task) => {
    setDismissing(task.key);
    setSaid(null);
    const answer = await sendDismiss(task.repo, task.runs[0].id);
    const name = { task: numberOf(task) || titleOf(task), repo: task.repo };
    setSaid({
      text: answer.error ?? t("overview.dismissed", name),
      error: !!answer.error,
    });
    if (!answer.error) await refresh?.();
    setDismissing(null);
  };

  // A failed run's row: its action, then Dismiss, which stops it asking.
  const actions = (row: Waiting): ComponentChildren => {
    const task = row.task;
    if (row.need !== "error" || !task.runs[0] || !manages(task)) return action(row, styles.action);
    return (
      <span class={styles.actions}>
        {action(row)}
        <Button
          size="small"
          variant="ghost"
          pending={dismissing === task.key}
          pendingLabel={t("overview.dismissing")}
          title={t("overview.dismissHelp")}
          onClick={() => void dismiss(task)}
        >
          {t("overview.dismiss")}
        </Button>
      </span>
    );
  };

  // The task page's own action: its questions' form, a brainstorm's thread (on GitHub, or the
  // dashboard's for a discussion), the pull request, Rerun; else the task page. `place`: its
  // class in the row, when it has the row's action column to itself.
  const action = ({ task, need }: Waiting, place?: string): ComponentChildren => {
    const label = t(BADGES[need].action);
    const link = (href: string, text: string, outside = true) => (
      <a
        class={buttonClass("secondary", "small", place)}
        href={href}
        {...(outside ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {text}
      </a>
    );
    const page = taskHref(task);
    const issue = githubUrl(task, github);
    if (need === "input") {
      // A run's questions: its session goes on in its mode.
      if (
        task.questions &&
        (task.questions.source === "run" ? goesOn(task, task.mode) : manages(task))
      )
        return (
          <Button size="small" class={place} onClick={() => setAnswering(task)}>
            {label}
          </Button>
        );
      return issue ? link(issue, label) : link(page, label, false);
    }
    if (need === "turn")
      return task.kind === "discussion" || !issue ? link(page, label, false) : link(issue, label);
    if (need === "ready" && task.pr) return link(task.pr.url, label);
    if (need === "error" && task.rerunnable && task.runs[0] && goesOn(task, task.runs[0].taskMode))
      return (
        <Button
          size="small"
          class={place}
          pending={rerunning === task.key}
          pendingLabel={t("overview.rerunning")}
          title={t("overview.rerunHelp")}
          onClick={() => void rerun(task)}
        >
          {label}
        </Button>
      );
    return link(page, t("overview.open"), false);
  };

  return (
    <Card as="section" class={styles.needs} aria-labelledby="waiting-on-you">
      <div class={styles.needsHead}>
        <h2 id="waiting-on-you" class={styles.section}>
          {t("overview.waitingOnYou")}
        </h2>
        {rows.length > 1 && <span class={styles.meta}>{t("overview.oldestFirst")}</span>}
      </div>
      {said && (
        <Notice tone={said.error ? "err" : "done"} class={styles.said}>
          {said.text}
        </Notice>
      )}
      {rows.length ? (
        <ul class={styles.rows}>
          {rows.map((row) => {
            const task = row.task;
            const badge = BADGES[row.need].label;
            return (
              <li
                key={task.key}
                class={`${styles.need} ${row.need === "ready" && readyStatus(task)?.tone === "input" ? styles.warned : ""}`}
              >
                <StatusBadge
                  class={styles.badge}
                  state={task.state}
                  {...(row.need === "ready" ? readyStatus(task) : { label: badge && t(badge) })}
                />
                <span class={styles.titleCell}>
                  <a class={styles.needTitle} href={taskHref(task)}>
                    {/* Without a title, titleOf() says the number already. */}
                    {task.title && task.number !== null && (
                      <span class={styles.number}>{numberOf(task)} </span>
                    )}
                    {titleOf(task)}
                  </a>
                  {/* Where you decide what to review: its pull request's CI. */}
                  {row.need === "ready" && task.pr && <CiStatus pr={task.pr} link />}
                </span>
                {row.need === "ready" && <ReviewMarks task={task} class={styles.left} />}
                <span class={styles.needRepo}>{task.repo}</span>
                <span class={styles.age} title={new Date(row.at).toLocaleString(locale())}>
                  {age(row.at, now)}
                </span>
                {actions(row)}
              </li>
            );
          })}
        </ul>
      ) : (
        <p class={styles.empty}>{t("overview.nothingWaits")}</p>
      )}
      {answering?.questions && (
        <Dialog
          title={t("overview.answerTitle", { task: numberOf(answering) || titleOf(answering) })}
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
  const active = repoTabs(state.tasks).map((tab) => tab.repo);
  const listed = repos?.repos ?? [];
  const names = [
    ...active,
    ...listed.map((r) => r.repo).filter((name) => !active.some((a) => sameRepo(a, name))),
  ];
  return (
    <section class={styles.repos} aria-labelledby="overview-repos">
      <h2 id="overview-repos" class={styles.section}>
        {t("overview.repositories")}
      </h2>
      {repos?.error && !repos.repos && (
        <Notice tone="err">{t("overview.cantList", { error: repos.error })}</Notice>
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
          {repos && !repos.repos && !repos.error
            ? t("overview.loading")
            : t("overview.noRepository")}
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
  const tasks = state.tasks.filter((task) => sameRepo(task.repo, name));
  const parts = repoParts(tasks, state.now);
  const status = row?.status ?? null;
  const summary = parts.map((p) => p.words).join(" · ");
  const config = formatRoute({ repo: null, task: null, run: null, page: "settings", config: name });
  const board = formatRoute({ repo: name, task: null, run: null, page: "board" });
  const failed = repos?.failed?.repo === name ? repos.failed.error : null;
  // Onboarding reads its config and starts its run; See config reads the config.
  const can = useCan();
  const reads = can.repo(name, "repo:config:read");

  let text: ComponentChildren = summary || t("overview.nothingGoingOn");
  let foot: string | null = backlogLine(
    row?.backlog,
    laneCount(name, state.tasks, state.edges, state.blockers),
  );
  let main = (
    <a class={buttonClass("secondary", "small")} href={board}>
      {t("overview.openBoard")}
    </a>
  );
  if (status === "not-onboarded" && reads && can.start(name, "onboarding")) {
    text = row?.issues ? t("overview.onboardHelp") : t("overview.issuesOff");
    foot = t("overview.noConfig");
    main = (
      <Button
        size="small"
        variant="primary"
        disabled={!row?.issues || !repos || (!!repos.starting && repos.starting !== name)}
        pending={repos?.starting === name}
        pendingLabel={t("overview.onboarding")}
        onClick={() => void repos?.onboard(name)}
      >
        {t("overview.onboard")}
      </Button>
    );
  } else if (status === "onboarding" && row?.issue) {
    text = summary || t("overview.onboardingOn", { number: row.issue.number });
    foot = t("overview.beingOnboarded");
    main = (
      <a
        class={buttonClass("secondary", "small")}
        href={row.issue.url}
        target="_blank"
        rel="noreferrer"
      >
        {t("overview.openIssue")}
      </a>
    );
  } else if (status === "invalid" && reads) {
    text = summary || t("overview.configErrors");
    main = (
      <a class={buttonClass("secondary", "small")} href={config}>
        {t("overview.seeConfig")}
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
      <span class={styles.bar} role="img" aria-label={summary || t("overview.noTasks")}>
        {parts.map((p) => (
          <span key={p.words} class={toneClass(p.tone)} style={{ flexGrow: p.count }} />
        ))}
      </span>
      <span class={styles.summary}>{text}</span>
      <RepoSlots state={state} repo={name} form="card" />
      {failed && <Notice tone="err">{failed}</Notice>}
      <div class={styles.cardFoot}>
        <span class={styles.meta}>{foot}</span>
        {main}
      </div>
    </Card>
  );
}
