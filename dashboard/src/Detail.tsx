// The open task: its kind, number and mode, its title, and its actions (GitHub, Stop while a
// run goes on, which asks once more first); then its facts and its runs as tabs over the run
// shown (the latest unless one was picked): its outcome (with Rerun when it failed) and its
// log. Waiting for input: its open questions, as a form to answer them. A discussion: its
// thread first, to read and reply to, with the last reply and Rerun, then its runs. A phone's
// log search takes the header's place.
import { useEffect, useState } from "preact/hooks";
import { sendCancel, sendRerun, useRunLog } from "./api";
import {
  ago,
  duration,
  githubUrl,
  isPrTask,
  kindName,
  modeOf,
  PR_NAMES,
  runName,
  taskTone,
  titleOf,
} from "./format";
import { Log } from "./Log";
import { copyText, downloadText } from "./logExport";
import { logSections, plainText } from "./logModel";
import { Outcome } from "./Outcome";
import { PolicyDecisions } from "./PullRequest";
import { Questions } from "./Questions";
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
const STOPPABLE: Task["state"][] = ["building-image", "working", "stopping"];
// A discussion's tab before its runs'.
const THREAD = "thread";
const PANEL = "task-view";

// "14:02", or "Oct 14, 14:02" on another day.
function startTime(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

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
  // The run whose rerun is on its way.
  const [rerunning, setRerunning] = useState<string | null>(null);
  // A discussion's page shows its thread, or a run's log.
  const [showLog, setShowLog] = useState(false);
  // The task whose Stop was pressed once (it asks again), and the one whose stop is on its way.
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
  const discussion = t.kind === "discussion" && t.number !== null;
  const thread = discussion && !showLog;
  const hidden = !!touch && searching && !thread && !!r;
  // A phone's More menu, for a run's log.
  const menu = !!touch && !thread && !!r;
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
  const asking = confirming === t.key;
  const stop = async () => {
    if (!asking) return setConfirming(t.key);
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
  const tabs = [
    ...(discussion ? [{ id: THREAD, label: "Thread" }] : []),
    ...t.runs.map((x, i) => ({
      id: x.id,
      label: (
        <span class={styles.run} title={i === 0 ? "Latest: follows the next runs" : x.id}>
          <StatusDot state={x.status} />
          {runName(x)}
          {x.speed === "fast" && " · fast"}{" "}
          <span class={styles.ago}>
            {x.status === "running" ? duration(x, now) : ago(x.startedAt, now)}
          </span>
        </span>
      ),
    })),
  ];
  const pick = (id: string) => {
    setShowLog(id !== THREAD);
    if (id !== THREAD) onRun(id === t.runs[0]?.id ? null : id);
  };
  return (
    <div class={styles.detail}>
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
                  onClick={() => again(failed)}
                >
                  Rerun
                </Button>
              )}
              {stoppable && asking && (
                <Button size={size} onClick={() => setConfirming(null)}>
                  Keep running
                </Button>
              )}
              {stoppable && (
                <Button
                  variant={asking ? "danger-solid" : "danger"}
                  size={size}
                  icon={<Icon.Stop size={11} />}
                  pending={stopping === t.key}
                  pendingLabel="Stopping…"
                  title="Stops the run now: what it did since its last push is lost"
                  onClick={stop}
                >
                  {asking ? "Stop it now" : "Stop"}
                </Button>
              )}
            </div>
          </div>
          <div class={styles.facts}>
            <StatusBadge state={t.state} tone={taskTone(t)} />
            {r && (
              <span>
                Started {startTime(r.startedAt, now)} ·{" "}
                <span class={styles.mono}>{duration(r, now)}</span>
              </span>
            )}
            {r?.model && thread && (
              <span>
                {r.model}
                {r.effort && ` · ${r.effort} effort`}
                {r.speed === "fast" && " · fast"}
              </span>
            )}
            {t.pr && <PrLink pr={t.pr} />}
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
          {reply && (thread || reply.id !== r?.id) && (
            <section class={styles.reply} aria-label="Last reply">
              <h3>Last reply</h3>
              <p>{reply.summary}</p>
            </section>
          )}
          <PolicyDecisions decisions={t.decisions} now={now} />
          {tabs.length > 0 && (
            <Tabs
              label={discussion ? "Thread and runs" : "Runs"}
              tabs={tabs}
              selected={thread ? THREAD : (r?.id ?? "")}
              onSelect={pick}
              panel={PANEL}
              class={styles.tabs}
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
      {thread ? (
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
