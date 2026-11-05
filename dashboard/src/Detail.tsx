// The open task: its kind, number and mode, its title, and its actions (GitHub, Stop while a
// run goes on, which asks first: Stop.tsx); then its facts and its runs as tabs, numbered from
// the oldest (#1), over the run shown (the latest unless one was picked). Past 3 runs, only the
// latest and the one shown have a tab, and All runs lists them all (RunMenu.tsx). The run
// shown: its outcome (with Rerun and Dismiss when it failed, and who dismissed it, with Undo)
// and its log. Waiting for input: its open questions, as a form to answer them. A discussion:
// its thread first, to read and reply to, with the last reply and Rerun, then its runs. A
// Policies tab when its pull request's policies decided something (with a badge when one kept
// it from merging by itself), and a Review tab once Deckhand reviewed it: the last review's
// findings, follow-ups and comments (ReviewTab.tsx). A phone's log search takes the header's
// place. Its shortcuts: O opens it on GitHub, A goes to its questions, R reruns, Shift S stops
// (asking first), Shift R reviews its pull request again and Shift F asks for one more fix
// round once its review loop is over, [ and ] go through its thread, every run (those without a
// tab too), its policies and its review.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useCan } from "./access";
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
  prTitle,
  reviewOffers,
  reviewOutdated,
  runName,
  shortSha,
  taskStatus,
  titleOf,
} from "./format";
import { type Handlers, useShortcuts, withKey } from "./keys";
// `tr`: t() where the task is called `t`.
import { and, locale, t as tr, tx } from "./i18n";
import { Log } from "./Log";
import { copyText, downloadText } from "./logExport";
import { logSections, plainText } from "./logModel";
import { CiStatus } from "./CiStatus";
import { AuthTag, Outcome } from "./Outcome";
import { heldMerge, PolicyTab } from "./Policies";
import { Questions } from "./Questions";
import { ReviewRounds } from "./ReviewLoop";
import { ReviewTab } from "./ReviewTab";
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
// A discussion's tab before its runs', and the Policies and Review tabs after them.
const THREAD = "thread";
const POLICIES = "policies";
const REVIEW = "review";
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
  // The task whose Policies or Review tab is open, and which.
  const [paneOf, setPaneOf] = useState<{ key: string; id: string } | null>(null);
  // The task whose Stop asks, and the one whose stop is on its way.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  // A phone searching the log: its search replaces the header.
  const [searching, setSearching] = useState(false);
  // A phone's More menu: GitHub, Copy and Download.
  const [more, setMore] = useState(false);
  // What the user may do on the task's repo (access.ts): the actions they may not aren't
  // offered, and a log they may not read isn't asked for.
  const can = useCan();
  const reads = !!t && can.repo(t.repo, "logs:read");
  const manages = !!t && can.repo(t.repo, "runs:manage");
  const starts = (mode: string | null | undefined) => !!t && can.start(t.repo, mode || "work");
  // The log of the run shown: its outcome's More menu copies it too.
  const { entries } = useRunLog(reads ? (r?.id ?? null) : null);
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
        <p class={styles.placeholder}>{tr("detail.pick")}</p>
      </div>
    );
  }
  const url = githubUrl(t, github);
  const mode = modeOf(t);
  const size = touch ? "touch" : "small";
  // The last reply: from the latest run that has one.
  const reply = t.runs.find((x) => x.summary);
  const questioned = t.state === "needs-input" ? t.questions : undefined;
  // Answering is runs:manage, and the start of its mode when a run asked them: its session
  // goes on (listener/work.mjs).
  const asked =
    manages && (questioned?.source !== "run" || starts(t.mode)) ? questioned : undefined;
  // The latest run only, and only when it is the one shown; runs:manage, and its mode's start.
  const failed =
    t.rerunnable && r && r.id === t.runs[0]?.id && manages && starts(r.taskMode) ? r : null;
  const dismissable = canDismiss(t) && manages ? t.runs[0] : null;
  const discussion = t.kind === "discussion" && t.number !== null;
  const decided = !!t.decisions?.length;
  // Deckhand posted a review on its pull request (the loop's or a maintainer's).
  const reviewed = !!t.pr && !!t.review?.history.length;
  const pane = paneOf?.key === t.key ? paneOf.id : null;
  const policies = decided && pane === POLICIES;
  const reviewShown = reviewed && pane === REVIEW;
  const thread = discussion && !showLog && !policies && !reviewShown;
  const held = heldMerge(t);
  const logShown = !thread && !policies && !reviewShown && !!r && reads;
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
      message: ok ? tr("detail.logCopied") : tr("detail.copyFailed"),
      error: !ok,
    });
  };
  // Discussions have no comment command to stop them by, nor the API's.
  const stoppable = STOPPABLE.includes(t.state) && t.number !== null && !discussion && manages;
  // Waiting for a slot: Stop takes it out of the queue, nothing to lose, no question.
  const unqueue = t.state === "queued" && t.number !== null && !discussion && manages;
  const asking = confirming === t.key;
  const stop = async () => {
    setConfirming(null);
    setStopping(t.key);
    const said = await sendCancel(t.repo, t.number!, isPrTask(t));
    setSent({
      key: t.key,
      message: said.error ?? said.message ?? tr("detail.stoppingSent"),
      error: !!said.error,
    });
    if (!said.error) await refresh?.();
    setStopping(null);
  };
  const again = async (run: Run) => {
    setRerunning(run.id);
    const said = await sendRerun(t.repo, run.id);
    setSent({ key: t.key, message: said.error ?? tr("detail.rerunQueued"), error: !!said.error });
    if (!said.error) await refresh?.();
    setRerunning(null);
  };
  // Review or Fix of its pull request, its review loop over: runs:manage, and the start of a
  // review run or of a work run.
  const offered = reviewOffers(t);
  const offers = {
    review: offered.review && manages && starts("review"),
    fix: offered.fix && manages && starts("work"),
  };
  const outdated = reviewOutdated(t);
  const pending = reviewing?.key === t.key ? reviewing.action : null;
  const review = async (action: "review" | "fix") => {
    setReviewing({ key: t.key, action });
    const said = await sendReview(t.repo, t.pr!.number, action);
    const done = action === "fix" ? tr("detail.fixQueued") : tr("detail.reviewQueued");
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
          pendingLabel={tr("detail.fixing")}
          disabled={pending === "review"}
          title={tr("detail.fixHelp")}
          shortcut="fix"
          onClick={() => review("fix")}
        >
          {tr("detail.fix")}
        </Button>
      )}
      {offers.review && (
        <Button
          size={size}
          pending={pending === "review"}
          pendingLabel={tr("detail.reviewing")}
          disabled={pending === "fix"}
          title={
            outdated
              ? tr("detail.reviewHeadHelp", { sha: shortSha(outdated.head) })
              : tr("detail.reviewHelp")
          }
          shortcut="review"
          onClick={() => review("review")}
        >
          {tr("detail.review")}
        </Button>
      )}
    </>
  );
  // Dismiss, or its Undo: the task's last run stops asking, or asks again.
  const dismiss = async (run: Run, undo = false) => {
    setDismissing(run.id);
    const said = await sendDismiss(t.repo, run.id, undo);
    const done = undo ? tr("detail.dismissUndone") : tr("detail.dismissedSent");
    setSent({ key: t.key, message: said.error ?? done, error: !!said.error });
    if (!said.error) await refresh?.();
    setDismissing(null);
  };
  // The latest run follows the next ones; an older one picked (or from the URL) is beside it.
  const many = t.runs.length > ALL_TABS;
  const tabbed = many ? t.runs.filter((x, i) => i === 0 || x.id === r?.id) : t.runs;
  const tabs = [
    ...(discussion ? [{ id: THREAD, label: tr("detail.thread") }] : []),
    ...tabbed.map((x) => ({
      id: x.id,
      // Narrow, it shrinks: its name cut short, which its title and All runs have whole.
      attrs: {
        class: styles.runTab,
        title: `${x === t.runs[0] ? tr("detail.latestTab") : x.id}\n${runName(x)}`,
      },
      label: (
        <span class={styles.run}>
          <span class={styles.number}>#{t.runs.length - t.runs.indexOf(x)}</span>{" "}
          <StatusDot state={x.status} />
          <span class={styles.name}>
            {runName(x)}
            {x.speed === "fast" && ` · ${tr("detail.fast")}`}
          </span>{" "}
          <span class={styles.ago}>
            {x.status === "running" ? duration(x, now) : ago(x.startedAt, now)}
          </span>
        </span>
      ),
    })),
    ...(decided
      ? [{ id: POLICIES, label: tr("detail.policies"), count: t.decisions!.length }]
      : []),
    ...(reviewed ? [{ id: REVIEW, label: tr("detail.reviewTab") }] : []),
  ];
  // "Thread, runs, policies and review", what the tabs are: its first letter as the locale
  // writes it in capital.
  const listed = and(
    [
      discussion && tr("detail.tabsThread"),
      tr("detail.tabsRuns"),
      decided && tr("detail.tabsPolicies"),
      reviewed && tr("detail.tabsReview"),
    ].filter((x): x is string => !!x),
  );
  const tabsLabel = listed.charAt(0).toLocaleUpperCase(locale()) + listed.slice(1);
  const pick = (id: string) => {
    const aside = id === POLICIES || id === REVIEW;
    setPaneOf(aside ? { key: t.key, id } : null);
    if (aside) return;
    setShowLog(id !== THREAD);
    if (id !== THREAD) onRun(id === t.runs[0]?.id ? null : id);
  };
  const selected = policies ? POLICIES : reviewShown ? REVIEW : thread ? THREAD : (r?.id ?? "");
  keys.github = () => (url ? void window.open(url, "_blank", "noreferrer") : false);
  keys.answer = () => {
    const field = root.current?.querySelector<HTMLElement>(
      "form[data-questions] input, form[data-questions] textarea",
    );
    if (!field) return false;
    field.focus();
    field.scrollIntoView?.({ block: "nearest" });
  };
  keys.rerun = () => {
    const last = t.rerunnable && manages && starts(t.runs[0]?.taskMode) ? t.runs[0] : null;
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
    ...(reviewed ? [REVIEW] : []),
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
              {tr("detail.back")}
            </Button>
            {menu && (
              <IconButton
                variant="ghost"
                size="touch"
                label={tr("detail.more")}
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
                {mode && ` · ${tr("detail.mode", { mode })}`}
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
                  title={withKey(tr("detail.openGithub"), "github")}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon.External size={14} />
                  {tr("detail.github")}
                </a>
              )}
              {failed && thread && (
                <Button
                  variant="primary"
                  size={size}
                  pending={rerunning === failed.id}
                  pendingLabel={tr("detail.rerunning")}
                  title={tr("detail.rerunHelp")}
                  shortcut="rerun"
                  onClick={() => again(failed)}
                >
                  {tr("detail.rerun")}
                </Button>
              )}
              {dismissable && thread && (
                <Button
                  size={size}
                  pending={dismissing === dismissable.id}
                  pendingLabel={tr("detail.dismissing")}
                  title={tr("detail.dismissHelp")}
                  onClick={() => dismiss(dismissable)}
                >
                  {tr("detail.dismiss")}
                </Button>
              )}
              {stoppable && (
                <Button
                  variant="danger"
                  size={size}
                  icon={<Icon.Stop size={11} />}
                  pending={stopping === t.key}
                  pendingLabel={tr("detail.stopping")}
                  title={tr("detail.stopHelp")}
                  shortcut="stop"
                  onClick={() => setConfirming(t.key)}
                >
                  {tr("detail.stop")}
                </Button>
              )}
              {unqueue && (
                <Button
                  variant="danger"
                  size={size}
                  icon={<Icon.Stop size={11} />}
                  pending={stopping === t.key}
                  pendingLabel={tr("detail.removing")}
                  title={tr("detail.unqueueHelp")}
                  shortcut="stop"
                  onClick={stop}
                >
                  {tr("detail.unqueue")}
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
            {held && <StatusBadge tone="input" label={tr("detail.held")} />}
            {r && (
              <span>
                {tx("detail.started", {
                  when: dayTime(r.startedAt, now, false),
                  took: <span class={styles.mono}>{duration(r, now)}</span>,
                })}
              </span>
            )}
            {r?.model && thread && (
              <span>
                {r.model}
                {r.effort && ` · ${tr("detail.effort", { effort: r.effort })}`}
                {r.speed === "fast" && ` · ${tr("detail.fast")}`}
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
                {tr("detail.dismissedBy", { user: t.dismissed.by, ago: ago(t.dismissed.at, now) })}
                {manages && (
                  <Button
                    variant="ghost"
                    size="small"
                    pending={dismissing === t.runs[0].id}
                    pendingLabel={tr("detail.undoing")}
                    title={tr("detail.undoHelp")}
                    onClick={() => dismiss(t.runs[0], true)}
                  >
                    {tr("detail.undo")}
                  </Button>
                )}
              </span>
            )}
            {!!t.waitingFor?.length && (
              <span>
                {tx("detail.nextRunAfter", {
                  issues: linkList(
                    t.waitingFor.map((n) => (
                      <a
                        key={n}
                        href={`${github}/${t.repo}/issues/${n}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        #{n}
                      </a>
                    )),
                  ),
                })}
              </span>
            )}
            {url && t.replyTo !== t.number && t.replyTo !== t.pr?.number && (
              <a href={url} target="_blank" rel="noreferrer">
                {tr("detail.repliesOn", { number: t.replyTo! })}
              </a>
            )}
          </div>
          <ReviewRounds task={t} actions={reviewActions || undefined} />
          {reply && (thread || reply.id !== r?.id) && (
            <section class={styles.reply} aria-label={tr("detail.lastReply")}>
              <h3>{tr("detail.lastReply")}</h3>
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
        <Sheet title={tr("detail.runLog")} onClose={() => setMore(false)}>
          <div class={styles.menu}>
            {url && (
              <a
                class={buttonClass("ghost", "touch", styles.menuItem)}
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                <Icon.External size={18} />
                {tr("detail.openGithub")}
              </a>
            )}
            <Button
              variant="ghost"
              size="touch"
              class={styles.menuItem}
              icon={<Icon.Copy size={18} />}
              onClick={copyLog}
            >
              {tr("detail.copyLog")}
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
              {tr("detail.download")}
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
      ) : reviewShown ? (
        <div id={PANEL} role="tabpanel" class={styles.panel}>
          <ReviewTab key={t.key} task={t} now={now} />
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
          {reads ? (
            <Log
              key={r.id}
              run={r}
              entries={entries}
              now={now}
              touch={touch}
              searching={searching}
              onSearching={setSearching}
            />
          ) : (
            <p class={styles.placeholder}>
              {tx("detail.noLogs", { permission: <code>logs:read</code>, repo: t.repo })}
            </p>
          )}
        </div>
      ) : asked ? null : questioned ? (
        <p class={styles.placeholder}>{tr("detail.waitingAnswers")}</p>
      ) : t.state === "needs-input" ? (
        // Labelled for its open questions (an inbox run filed it, or someone wrote it so).
        <p class={styles.placeholder}>{tr("detail.waitingAnswersGithub")}</p>
      ) : (
        <p class={styles.placeholder}>{tr("detail.waitingFirstRun", { title: titleOf(t) })}</p>
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
      title={auto ? prTitle(pr) : undefined}
    >
      <Icon.Branch size={14} />
      {auto ? tr("detail.mergedByDeckhand") : tr(PR_NAMES[pr.state])}{" "}
      <span class={styles.mono}>#{pr.number}</span>
    </a>
  );
}

// "#3", "#3 and #4", "#3, #4 and #5": links joined as the language does (and() in i18n.ts).
function linkList(links: ComponentChildren[]): ComponentChildren {
  if (links.length < 2) return links[0];
  const first = links
    .slice(0, -1)
    .flatMap((link, i) => (i > 0 ? [tr("list.comma"), link] : [link]));
  return tx("list.and", { first, last: links.at(-1)! });
}
