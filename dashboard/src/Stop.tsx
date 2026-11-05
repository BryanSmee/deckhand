// Stop's question, before a run ends: what is lost (what it did since its last push, which
// the listener records: listener/git-gateway.mjs) and what stays (its branch, its pull request).
import { ago } from "./format";
import { locale } from "./i18n";
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
  `${new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}, ${ago(at, now)}`;

export function stopNote(t: Task, run: Run | null, now: number): string {
  const push = run?.lastPushAt;
  const pr = t.pr && `${t.pr.state === "draft" ? "draft " : ""}pull request #${t.pr.number}`;
  // Absent: a run from before pushes were recorded, which may have pushed or not.
  const lost =
    push === null
      ? "It hasn't pushed yet: what it did is lost"
      : `What it did since its last push${push ? ` (${when(push, now)})` : ""} is lost`;
  const stays =
    push === null
      ? pr && `; ${pr} stays as it is`
      : pr
        ? `; the branch and ${pr} stay as they are`
        : "; the branch stays as it is";
  return `It ends now. ${lost}${stays || ""}.`;
}

export function StopDialog({ task: t, run, now, onStop, onClose }: Props) {
  return (
    <Dialog
      alert
      icon={<Stop size={18} />}
      title={
        <>
          Stop the run on <span class="mono">#{t.number}</span>?
        </>
      }
      sub={stopNote(t, run, now)}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep running
          </Button>
          <Button variant="danger-solid" onClick={onStop}>
            Stop the run
          </Button>
        </>
      }
    />
  );
}
