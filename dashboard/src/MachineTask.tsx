// A machine task on its page (listener/claims.mjs, #596): whose machines take it and whether one
// does now (MachineFact, among the task's facts), and the comments other people left on it, held
// until its owner delivers or drops them (HeldComments): only the owner gets the buttons, and the
// orchestrator refuses anyone else.
import { useState } from "preact/hooks";
import { postJson } from "./api";
import { ago, machineName } from "./format";
// `tr`: t() where the task is called `t`.
import { t as tr } from "./i18n";
import type { Task } from "./types";
import { Button } from "./ui/Button";
import styles from "./MachineTask.module.css";

// "Runs on @alice's machines labelled unreal: none online", "… : on Desk".
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
