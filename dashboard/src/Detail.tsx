// The open task: its kind, number and mode, its title, and its actions (GitHub, Stop while a
// run goes on, which asks first: Stop.tsx); then its facts and its runs as tabs, numbered from
// the oldest (#1), over the run shown (the latest unless one was picked). Past 3 runs, only the
// latest and the one shown have a tab, and All runs lists them all (RunMenu.tsx). The run
// shown: its outcome (with Rerun and Dismiss when it failed, and who dismissed it, with Undo)
// and its log. Waiting for input: its open questions, as a form to answer them. A discussion:
// its thread first, to read and reply to, with the last reply and Rerun, then its runs. A
// Policies tab when its pull request's policies decided something (with a badge when one kept
// it from merging by itself). A phone's log search takes the header's place. Its shortcuts: O
// opens it on GitHub, A goes to its questions, R reruns, Shift S stops (asking first), Shift R
// reviews its pull request again and Shift F asks for one more fix round once its review loop
// is over, [ and ] go through its thread, every run (those without a tab too) and its policies.
import { useEffect, useRef, useState } from "preact/hooks";
import { sendCancel, sendDismiss, sendRerun, sendReview, useRunLog } from "./api";
import {
  ago,
  canDismiss,
  dayTime,
  duration,
  githubUrl,
  isPrTask,
  kindName,
  loopLine,
  modeOf,
  PR_NAMES,
  reviewOffers,
  reviewOutdated,
  runName,
  shortSha,
  taskStatus,
  titleOf,
} from "./format";
import { type Handlers, useShortcuts, withKey } from "./keys";
import { Log } from "./Log";
import { copyText, downloadText } from "./logExport";
import { logSections, plainText } from "./logModel";
import { CiStatus } from "./CiStatus";
import { AuthTag, Outcome } from "./Outcome";
import { heldMerge, PolicyTab } from "./Policies";
import { Questions } from "./Questions";
import { ReviewRounds } from "./ReviewLoop";
import { RunMenu } from "./RunMenu";
import { StopDialog } from "./Stop";
import { Thread } from "./Thread";
import type { PullRequest, Run, Task } from "./types";
import { Button, buttonClass, IconButton } from "./ui/Button";
import { Sheet } from "./ui/Sheet";
import * as Icon from "./ui/icons";
import { StatusBadge, StatusDot } from "./ui/Status";
import { Tabs } from "./ui/Tabs";
import styles from "./Detail.module.css";

interface Props {
  task: Task | null;
  run: Run | null;
  onRun: (id: string | null) => void;
  onBack: () => void;
  now: number;
  // api/state's githubUrl.
  github: string;
  // All repositories: the header names the task's repo.
  showRepo?: boolean;
  // A phone's: 44 px targets.
  touch?: boolean;
  // Reads api/state again (answers sent, a rerun queued, a run stopped).
  refresh?: () => Promise<void>;
}

// The states a run is going on in, which Stop ends.
const STOPPABLE: Task["state"][] = ["scheduled", "building-image", "working", "stopping"];
// A discussion's tab before its runs', and the Policies tab after them.
const THREAD = "thread";
const POLICIES = "policies";
const PANEL = "task-view";
// Up to this many runs, each has a tab; past it, the latest and the one shown only.
const ALL_TABS = 3;

export function Detail({
  task: t,
  run: r,
  onRun,
  onBack,
  now,
  github,
  showRepo,
  touch,
  refresh,
}: Props) {
  // What the listener said of the answers sent or the rerun asked last, on that task's page.
  const [sent, setSent] = useState<{ key: string; message: string; error?: boolean } | null>(null);
  // The run whose rerun is on its way, and the one whose dismissal (or its undo) is.
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  // The task whose Review or Fix is on its way, and which.
  const [reviewing, setReviewing] = useState<{ key: string; action: "review" | "fix" } | null>(
    null,
  );
  // A discussion's page shows its thread, or a run's log.
  const [showLog, setShowLog] = useState(false);
  // The task whose Policies tab is open.
  const [policiesOf, setPoliciesOf] = useState<string | null>(null);
  // The task whose Stop asks, and the one whose stop is on its way.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  // A phone searching the log: its search replaces the header.
  const [searching, setSearching] = useState(false);
  // A phone's More menu: GitHub, Copy and Download.
  const [more, setMore] = useState(false);
  // The log of the run shown: its outcome's More menu copies it too.
  const { entries } = useRunLog(r?.id ?? null);
  useEffect(() => {
    setSearching(false);
    setMore(false);
  }, [t?.key]);
  const root = useRef<HTMLDivElement>(null);
  // Filled in below, once there is a task: the hook is called before the early return.
  const keys: Handlers = {};
  useShortcuts(keys, !!t);
  if (!t) {
    return (
      <div class={styles.detail}>
        <p class={styles.placeholder}>Pick an issue or pull request</p>
      </div>
    );
  }
  const url = githubUrl(t, github);
  const mode = modeOf(t);
  const size = touch ? "touch" : "small";
  // The last reply: from the latest run that has one.
  const reply = t.runs.find((x) => x.summary);
  const asked = t.state === "needs-input" ? t.questions : undefined;
  // The latest run only, and only when it is the one shown.
  const failed = t.rerunnable && r && r.id === t.runs[0]?.id ? r : null;
  const dismissable = canDismiss(t) ? t.runs[0] : null;
  const discussion = t.kind === "discussion" && t.number !== null;
  const decided = !!t.decisions?.length;
  const policies = decided && policiesOf === t.key;
  const thread = discussion && !showLog && !policies;
  const held = heldMerge(t);
  const logShown = !thread && !policies && !!r;
  const hidden = !!touch && searching && logShown;
  // A phone's More menu, for a run's log.
  const menu = !!touch && logShown;
  const logText = () =>
    r ? plainText(logSections(entries, r.finishedAt ?? now, r.status === "running")) : "";
  const copyLog = async () => {
    setMore(false);
    const ok = await copyText(logText());
    setSent({
      key: t.key,
      message: ok ? "Log copied." : "Couldn't copy the log: download it instead.",
      error: !ok,
    });
  };
  // Discussions have no comment command to stop them by, nor the API's.
  const stoppable = STOPPABLE.includes(t.state) && t.number !== null && !discussion;
  // Waiting for a slot: Stop takes it out of the queue, nothing to lose, no question.
  const unqueue = t.state === "queued" && t.number !== null && !discussion;
  const asking = confirming === t.key;
  const stop = async () => {
    setConfirming(null);
    setStopping(t.key);
    const said = await sendCancel(t.repo, t.number!, isPrTask(t));
    setSent({
      key: t.key,
      message: said.error ?? said.message ?? "Stopping.",
      error: !!said.error,
    });
    if (!said.error) await refresh?.();
    setStopping(null);
  };
  const again = async (run: Run) => {
    setRerunning(run.id);
    const said = await sendRerun(t.repo, run.id);
    setSent({ key: t.key, message: said.error ?? "Rerun queued.", error: !!said.error });
    if (!said.error) await refresh?.();
    setRerunning(null);
  };
  // Review or Fix of its pull request, its review loop over.
  const offers = reviewOffers(t);
  const outdated = reviewOutdated(t);
  const pending = reviewing?.key === t.key ? reviewing.action : null;
  const review = async (action: "review" | "fix") => {
    setReviewing({ key: t.key, action });
    const said = await sendReview(t.repo, t.pr!.number, action);
    const done = action === "fix" ? "Fix round queued." : "Review queued.";
    setSent({ key: t.key, message: said.error ?? said.message ?? done, error: !!said.error });
    if (!said.error) await refresh?.();
    setReviewing(null);
  };
  const reviewActions = (offers.review || offers.fix) && (
    <>
      {offers.fix && (
        <Button
          variant="primary"
          size={size}
          pending={pending === "fix"}
          pendingLabel="Fixing…"
          disabled={pending === "review"}
          title="One more fix run on the last review's findings, then its review"
          shortcut="fix"
          onClick={() => review("fix")}
        >
          Fix
        </Button>
      )}
      <Button
        size={size}
        pending={pending === "review"}
        pendingLabel="Reviewing…"
        disabled={pending === "fix"}
        title={
          outdated
            ? `Reviews the new head, ${shortSha(outdated.head)}, as /mode review does`
            : "Reviews the pull request's head now, as /mode review does"
        }
        shortcut="review"
        onClick={() => review("review")}
      >
        Review
      </Button>
    </>
  );
  // Dismiss, or its Undo: the task's last run stops asking, or asks again.
  const dismiss = async (run: Run, undo = false) => {
    setDismissing(run.id);
    const said = await sendDismiss(t.repo, run.id, undo);
    const done = undo ? "Dismissal undone." : "Dismissed: it no longer waits on you.";
    setSent({ key: t.key, message: said.error ?? done, error: !!said.error });
    if (!said.error) await refresh?.();
    setDismissing(null);
  };
  // The latest run follows the next ones; an older one picked (or from the URL) is beside it.
  const many = t.runs.length > ALL_TABS;
  const tabbed = many ? t.runs.filter((x, i) => i === 0 || x.id === r?.id) : t.runs;
  const tabs = [
    ...(discussion ? [{ id: THREAD, label: "Thread" }] : []),
    ...tabbed.map((x) => ({
      id: x.id,
      // Narrow, it shrinks: its name cut short, which its title and All runs have whole.
      attrs: {
        class: styles.runTab,
        title: `${x === t.runs[0] ? "Latest: follows the next runs" : x.id}\n${runName(x)}`,
      },
      label: (
        <span class={styles.run}>
          <span class={styles.number}>#{t.runs.length - t.runs.indexOf(x)}</span>{" "}
          <StatusDot state={x.status} />
          <span class={styles.name}>
            {runName(x)}
            {x.speed === "fast" && " · fast"}
          </span>{" "}
          <span class={styles.ago}>
            {x.status === "running" ? duration(x, now) : ago(x.startedAt, now)}
          </span>
        </span>
      ),
    })),
    ...(decided ? [{ id: POLICIES, label: "Policies", count: t.decisions!.length }] : []),
  ];
  const tabsLabel = discussion
    ? decided
      ? "Thread, runs and policies"
      : "Thread and runs"
    : decided
      ? "Runs and policies"
      : "Runs";
  const pick = (id: string) => {
    setPoliciesOf(id === POLICIES ? t.key : null);
    if (id === POLICIES) return;
    setShowLog(id !== THREAD);
    if (id !== THREAD) onRun(id === t.runs[0]?.id ? null : id);
  };
  const selected = policies ? POLICIES : thread ? THREAD : (r?.id ?? "");
  keys.github = () => (url ? void window.open(url, "_blank", "noreferrer") : false);
  keys.answer = () => {
    const field = root.current?.querySelector<HTMLElement>(
      "form[aria-label='Open questions'] input, form[aria-label='Open questions'] textarea",
    );
    if (!field) return false;
    field.focus();
    field.scrollIntoView?.({ block: "nearest" });
  };
  keys.rerun = () => {
    const last = t.rerunnable ? t.runs[0] : null;
    if (!last || rerunning) return false;
    void again(last);
  };
  keys.review = () => (offers.review && !pending ? void review("review") : false);
  keys.fix = () => (offers.fix && !pending ? void review("fix") : false);
  keys.stop = () =>
    stopping === t.key ? false : stoppable ? setConfirming(t.key) : unqueue ? void stop() : false;
  // ] and [: every run in turn, not only those with a tab.
  const order = [
    ...(discussion ? [THREAD] : []),
    ...t.runs.map((x) => x.id),
    ...(decided ? [POLICIES] : []),
  ];
  keys.nextRun = (i) => {
    const next = order[order.indexOf(selected) + (i === 0 ? 1 : -1)];
    if (!next) return false;
    pick(next);
  };
  return (
    <div class={styles.detail} ref={root}>
      {!hidden && (
        <header class={styles.head}>
          <div class={styles.phoneBar}>
            <Button
              variant="ghost"
              size="touch"
              icon={<Icon.ChevronLeft size={18} />}
              onClick={onBack}
            >
              Back
            </Button>
            {menu && (
              <IconButton
                variant="ghost"
                size="touch"
                label="More: open on GitHub, copy, download"
                icon={<Icon.More size={20} />}
                aria-haspopup="dialog"
                onClick={() => setMore(true)}
              />
            )}
          </div>
          <div class={styles.top}>
            <div class={styles.heading}>
              <span class={styles.context}>
                {showRepo && (
                  <>
                    <a href={`${github}/${t.repo}`} target="_blank" rel="noreferrer">
                      {t.repo}
                    </a>
                    {" · "}
                  </>
                )}
                {kindName(t)}
                {t.number !== null && (
                  <>
                    {" "}
                    <span class={styles.mono}>#{t.number}</span>
                  </>
                )}
                {mode && ` · ${mode} mode`}
              </span>
              <h2 class={styles.title}>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer">
                    {titleOf(t)}
                  </a>
                ) : (
                  titleOf(t)
                )}
              </h2>
            </div>
            <div class={styles.actions}>
              {url && !menu && (
                <a
                  class={buttonClass("secondary", size)}
                  title={withKey("Open on GitHub", "github")}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon.External size={14} />
                  GitHub
                </a>
              )}
              {failed && thread && (
                <Button
                  variant="primary"
                  size={size}
                  pending={rerunning === failed.id}
                  pendingLabel="Rerunning…"
                  title="Runs it again with the same comments and mode"
                  shortcut="rerun"
                  onClick={() => again(failed)}
                >
                  Rerun
                </Button>
              )}
              {dismissable && thread && (
                <Button
                  size={size}
                  pending={dismissing === dismissable.id}
                  pendingLabel="Dismissing…"
                  title="It stops waiting on you until another run"
                  onClick={() => dismiss(dismissable)}
                >
                  Dismiss
                </Button>
              )}
              {stoppable && (
                <Button
                  variant="danger"
                  size={size}
                  icon={<Icon.Stop size={11} />}
                  pending={stopping === t.key}
                  pendingLabel="Stopping…"
                  title="Stops the run now: what it did since its last push is lost"
                  shortcut="stop"
                  onClick={() => setConfirming(t.key)}
                >
                  Stop
                </Button>
              )}
              {unqueue && (
                <Button
                  variant="danger"
                  size={size}
                  icon={<Icon.Stop size={11} />}
                  pending={stopping === t.key}
                  pendingLabel="Removing…"
                  title="Takes it out of the queue: its queued comments are dropped"
                  shortcut="stop"
                  onClick={stop}
                >
                  Remove from queue
                </Button>
              )}
              {stoppable && asking && (
                <StopDialog
                  task={t}
                  run={t.runs[0] ?? null}
                  now={now}
                  onStop={stop}
                  onClose={() => setConfirming(null)}
                />
              )}
            </div>
          </div>
          <div class={styles.facts}>
            <StatusBadge state={t.state} {...taskStatus(t)} />
            {loopLine(t) && <span>{loopLine(t)}</span>}
            {held && <StatusBadge tone="input" label="Not merged automatically" />}
            {r && (
              <span>
                Started {dayTime(r.startedAt, now, false)} ·{" "}
                <span class={styles.mono}>{duration(r, now)}</span>
              </span>
            )}
            {r?.model && thread && (
              <span>
                {r.model}
                {r.effort && ` · ${r.effort} effort`}
                {r.speed === "fast" && " · fast"}
                {r.auth && " · "}
                <AuthTag auth={r.auth} />
              </span>
            )}
            {!r?.model && thread && <AuthTag auth={r?.auth} />}
            {t.pr && (
              <span class={styles.pr}>
                <PrLink pr={t.pr} />
                <CiStatus pr={t.pr} link />
              </span>
            )}
            {t.dismissed && t.runs[0] && (
              <span class={styles.dismissed}>
                Dismissed by @{t.dismissed.by} {ago(t.dismissed.at, now)}
                <Button
                  variant="ghost"
                  size="small"
                  pending={dismissing === t.runs[0].id}
                  pendingLabel="Undoing…"
                  title="Takes the dismissal back: a failure that still asks waits on you again"
                  onClick={() => dismiss(t.runs[0], true)}
                >
                  Undo
                </Button>
              </span>
            )}
            {!!t.waitingFor?.length && (
              <span>
                Next run after{" "}
                {t.waitingFor.map((n, i) => (
                  <span key={n}>
                    {i > 0 && (i === t.waitingFor!.length - 1 ? " and " : ", ")}
                    <a href={`${github}/${t.repo}/issues/${n}`} target="_blank" rel="noreferrer">
                      #{n}
                    </a>
                  </span>
                ))}
              </span>
            )}
            {url && t.replyTo !== t.number && t.replyTo !== t.pr?.number && (
              <a href={url} target="_blank" rel="noreferrer">
                Replies on #{t.replyTo}
              </a>
            )}
          </div>
          <ReviewRounds task={t} actions={reviewActions || undefined} />
          {reply && (thread || reply.id !== r?.id) && (
            <section class={styles.reply} aria-label="Last reply">
              <h3>Last reply</h3>
              <p>{reply.summary}</p>
            </section>
          )}
          {tabs.length > 0 && (
            <Tabs
              label={tabsLabel}
              tabs={tabs}
              selected={selected}
              onSelect={pick}
              panel={PANEL}
              class={styles.tabs}
              extra={
                many && (
                  <RunMenu
                    runs={t.runs}
                    current={logShown ? r.id : null}
                    onPick={pick}
                    now={now}
                    touch={touch}
                  />
                )
              }
            />
          )}
        </header>
      )}
      {more && r && (
        <Sheet title="Run log" onClose={() => setMore(false)}>
          <div class={styles.menu}>
            {url && (
              <a
                class={buttonClass("ghost", "touch", styles.menuItem)}
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                <Icon.External size={18} />
                Open on GitHub
              </a>
            )}
            <Button
              variant="ghost"
              size="touch"
              class={styles.menuItem}
              icon={<Icon.Copy size={18} />}
              onClick={copyLog}
            >
              Copy the log
            </Button>
            <Button
              variant="ghost"
              size="touch"
              class={styles.menuItem}
              icon={<Icon.Download size={18} />}
              onClick={() => {
                setMore(false);
                downloadText(`${r.id}.txt`, logText());
              }}
            >
              Download as .txt
            </Button>
          </div>
        </Sheet>
      )}
      {sent?.key === t.key && !hidden && (
        <p class={sent.error ? styles.refused : styles.sent} role="status">
          {sent.message}
        </p>
      )}
      {asked && !hidden && (
        <Questions
          key={`${t.key} ${asked.raw}`}
          task={t}
          questions={asked}
          onSent={(message) => {
            setSent({ key: t.key, message });
            refresh?.();
          }}
        />
      )}
      {policies ? (
        <div id={PANEL} role="tabpanel" class={styles.panel}>
          <PolicyTab task={t} now={now} />
        </div>
      ) : thread ? (
        <div id={PANEL} role="tabpanel" class={styles.panel}>
          <Thread key={t.key} task={t} now={now} refresh={refresh} />
        </div>
      ) : r ? (
        <div id={PANEL} role="tabpanel" class={`${styles.panel} ${styles.runView}`}>
          {!hidden && (
            <Outcome
              task={t}
              run={r}
              now={now}
              github={github}
              touch={touch}
              onRerun={failed ? () => again(failed) : undefined}
              rerunning={!!failed && rerunning === failed.id}
              onDismiss={
                dismissable && r.id === dismissable.id ? () => dismiss(dismissable) : undefined
              }
              dismissing={!!dismissable && dismissing === dismissable.id}
            />
          )}
          <Log
            key={r.id}
            run={r}
            entries={entries}
            now={now}
            touch={touch}
            searching={searching}
            onSearching={setSearching}
          />
        </div>
      ) : asked ? null : t.state === "needs-input" ? (
        // Labelled for its open questions (an inbox run filed it, or someone wrote it so).
        <p class={styles.placeholder}>Waiting for answers to its open questions on GitHub</p>
      ) : (
        <p class={styles.placeholder}>Waiting for the first run of {titleOf(t)} to start…</p>
      )}
    </div>
  );
}

// The task's pull request: "Draft #34", "Ready for review #33", "Merged by Deckhand #30" (no
// human reviewed it: `review.merge`).
function PrLink({ pr }: { pr: PullRequest }) {
  const auto = pr.state === "merged" && pr.autoMerged;
  return (
    <a
      class={styles.pr}
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={
        auto ? `Pull request #${pr.number}, merged by Deckhand with no human review` : undefined
      }
    >
      <Icon.Branch size={14} />
      {auto ? "Merged by Deckhand" : PR_NAMES[pr.state]}{" "}
      <span class={styles.mono}>#{pr.number}</span>
    </a>
  );
}
