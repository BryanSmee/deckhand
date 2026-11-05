// Stop's question, before a run ends: what is lost (what it did since its last push, which
// the listener records: listener/git-gateway.mjs) and what stays (its branch, its pull request).
import { ago } from "./format";
// `tr`: t() where the task is called `t`.
import { locale, t as tr, tx } from "./i18n";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Stop } from "./ui/icons";
import type { Run, Task } from "./types";

interface Props {
  task: Task;
  // The run going on: its last push.
  run: Run | null;
  now: number;
  onStop: () => void;
  onClose: () => void;
}

// "14:12, 2 min ago".
const when = (at: number, now: number) =>
  tr("stop.when", {
    time: new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }),
    ago: ago(at, now),
  });

export function stopNote(t: Task, run: Run | null, now: number): string {
  const push = run?.lastPushAt;
  const pr =
    t.pr && tr(t.pr.state === "draft" ? "stop.draftPr" : "stop.pr", { number: t.pr.number });
  if (push === null) return pr ? tr("stop.notPushedPr", { pr }) : tr("stop.notPushed");
  // Absent: a run from before pushes were recorded, which may have pushed or not.
  if (!push) return pr ? tr("stop.pushedPr", { pr }) : tr("stop.pushed");
  const at = when(push, now);
  return pr ? tr("stop.pushedAtPr", { when: at, pr }) : tr("stop.pushedAt", { when: at });
}

export function StopDialog({ task: t, run, now, onStop, onClose }: Props) {
  return (
    <Dialog
      alert
      icon={<Stop size={18} />}
      title={tx("stop.title", { number: <span class="mono">#{t.number}</span> })}
      sub={stopNote(t, run, now)}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("stop.keep")}
          </Button>
          <Button variant="danger-solid" onClick={onStop}>
            {tr("stop.confirm")}
          </Button>
        </>
      }
    />
  );
}
