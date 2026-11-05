// A machine task on its page (listener/claims.mjs, #596): whose machines take it and whether one
// does now (MachineFact, among the task's facts), and the comments other people left on it, held
// until its owner delivers or drops them (HeldComments): only the owner gets the buttons, and the
// orchestrator refuses anyone else. And its run's agent's tool calls waiting for the owner's
// answer (ToolRequests, #600).
import { useState } from "preact/hooks";
import { answerToolRequest, postJson } from "./api";
import { ago, machineName } from "./format";
// `tr`: t() where the task is called `t`.
import { t as tr, tx as txr } from "./i18n";
import type { Run, Task, ToolAnswer, ToolRequest } from "./types";
import { Button } from "./ui/Button";
import * as Icon from "./ui/icons";
import styles from "./MachineTask.module.css";

// "Runs on @alice's machines labelled unreal: waiting for one of them to claim it", "Claimed by
// @alice's Desk".
export function MachineFact({ task: t }: { task: Task }) {
  const m = t.machine;
  if (!m) return null;
  const title =
    m.via === "label" ? tr("machine.byLabel", { want: m.want }) : tr("machine.byComment");
  if (m.claimed) {
    return (
      <span title={title}>
        {tr("machine.claimedBy", { owner: m.owner, machine: machineName(m) })}
      </span>
    );
  }
  const asked = m.machine
    ? tr("machine.one", { owner: m.owner, machine: m.machine })
    : tr(m.via === "label" ? "machine.labelled" : "machine.named", {
        owner: m.owner,
        want: m.want,
      });
  const now = m.available
    ? tr(m.machine ? "machine.waitingIt" : "machine.waitingOne")
    : tr(m.machine ? "machine.offline" : "machine.noneOnline");
  return <span title={title}>{tr("machine.runsOn", { asked, now })}</span>;
}

// "As Desk reports it: v2.1.3 · sandbox on · acceptEdits mode · Deckhand's settings":
// how an external run's agent runs, as its machine said at its claim (#599), never checked.
export function MachineSetup({ run: r }: { run: Run }) {
  const s = r.setup;
  if (!s || !r.machine) return null;
  const parts = [
    s.version && tr("machine.version", { version: s.version }),
    s.sandbox !== null && tr(s.sandbox ? "machine.sandboxOn" : "machine.sandboxOff"),
    s.permissionMode && tr("machine.permissionMode", { mode: s.permissionMode }),
    s.suggested !== null && tr(s.suggested ? "machine.suggested" : "machine.ownSettings"),
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <span title={tr("machine.reportedHelp")}>
      {tr("machine.reported", { machine: r.machine, setup: parts.join(" · ") })}
    </span>
  );
}

interface Props {
  task: Task;
  // The signed-in login: the owner's alone deliver or drop.
  user?: string;
  now: number;
  // Reads api/state again once one went through.
  refresh?: () => Promise<void>;
}

export function HeldComments({ task: t, user, now, refresh }: Props) {
  const [acting, setActing] = useState<"deliver" | "drop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const held = t.held ?? [];
  if (!held.length || !t.machine || t.number === null) return null;
  const owner = t.machine.owner;
  const mine = !!user && user.toLowerCase() === owner.toLowerCase();

  async function act(action: "deliver" | "drop") {
    setActing(action);
    setError(null);
    const answer = await postJson(`api/held/${t.repo}/${t.number}/${action}`);
    if (answer.error) setError(answer.error);
    await refresh?.();
    setActing(null);
  }

  return (
    <section class={styles.held} aria-label={tr("held.label")}>
      <h3>{tr("held.title", { count: held.length, owner })}</h3>
      <p class={styles.note}>{tr("held.note", { owner })}</p>
      <ul>
        {held.map((c, i) => (
          <li key={i}>
            <span class={styles.who}>
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer">
                  @{c.author ?? tr("held.someone")}
                </a>
              ) : (
                `@${c.author ?? tr("held.someone")}`
              )}
              {c.at !== null && ` · ${ago(c.at, now)}`}
            </span>
            <span class={styles.text}>{c.text}</span>
          </li>
        ))}
      </ul>
      {error && (
        <p class={styles.error} role="alert">
          {error}
        </p>
      )}
      {mine && (
        <div class={styles.actions}>
          <Button
            size="small"
            pending={acting === "deliver"}
            pendingLabel={tr("held.delivering")}
            disabled={acting !== null}
            onClick={() => void act("deliver")}
          >
            {tr("held.deliver")}
          </Button>
          <Button
            variant="ghost"
            size="small"
            pending={acting === "drop"}
            pendingLabel={tr("held.dropping")}
            disabled={acting !== null}
            onClick={() => void act("drop")}
          >
            {tr("held.drop")}
          </Button>
        </div>
      )}
    </section>
  );
}

// Its machine run's agent's tool calls waiting for the owner (listener/requests.mjs, #600): the
// tool and its input as text, never markup, and how long until no answer denies it. Shown to
// everyone who sees the task; the owner alone gets Allow once, Allow for this run and Deny, and
// the orchestrator refuses anyone else's.
export function ToolRequests({ task: t, user, now, refresh }: Props) {
  const requests = t.permissions ?? [];
  if (!requests.length || t.number === null) return null;
  return (
    <section class={styles.tools} aria-label={tr("tools.label")}>
      {requests.map((r) => (
        <ToolRequestCard key={r.id} task={t} request={r} user={user} now={now} refresh={refresh} />
      ))}
    </section>
  );
}

function ToolRequestCard({
  task: t,
  request: r,
  user,
  now,
  refresh,
}: Props & { request: ToolRequest }) {
  const [busy, setBusy] = useState<ToolAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mine = !!user && user.toLowerCase() === r.owner.toLowerCase();
  const minutes = Math.max(1, Math.ceil((r.expiresAt - now) / 60_000));

  async function answer(choice: ToolAnswer) {
    setBusy(choice);
    setError(null);
    const said = await answerToolRequest(t, r.id, choice);
    if (said.error) setError(said.error);
    await refresh?.();
    setBusy(null);
  }

  const button = (choice: ToolAnswer, label: string, variant?: "primary" | "danger") => (
    <Button
      size="small"
      variant={variant}
      pending={busy === choice}
      disabled={!!busy && busy !== choice}
      title={choice === "run" ? tr("tools.runHelp") : undefined}
      onClick={() => void answer(choice)}
    >
      {label}
    </Button>
  );

  return (
    <div class={styles.tool}>
      <p class={styles.toolTitle}>
        <Icon.Alert size={16} />
        <span>
          {txr("tools.asks", {
            machine: r.machine,
            tool: <span class={styles.mono}>{r.tool}</span>,
          })}
        </span>
      </p>
      {r.input && <p class={styles.input}>{r.input}</p>}
      <p class={styles.note}>
        {tr("tools.note", { owner: r.owner })} {tr("tools.deniedIn", { count: minutes })}
      </p>
      {error && (
        <p class={styles.error} role="alert">
          {error}
        </p>
      )}
      {mine && (
        <div class={styles.actions}>
          {button("once", tr("tools.once"), "primary")}
          {button("run", tr("tools.run"))}
          {button("deny", tr("tools.deny"), "danger")}
        </div>
      )}
    </div>
  );
}
