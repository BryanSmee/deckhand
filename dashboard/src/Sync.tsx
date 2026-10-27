// The sidebar's Sync (Shell.tsx): GitHub sometimes loses webhook deliveries (an outage, the
// listener restarting). The listener asks for the failed ones again every few minutes on its
// own; this asks now, and reads the open pull requests' states again, then the board.
import { useEffect, useState } from "preact/hooks";
import { postJson } from "./api";
import { plural } from "./format";
import type { SyncResult } from "./types";

// How long what it did stays shown.
const SHOWN_MS = 8000;

export function syncMessage({
  redelivered,
  pulls,
}: Pick<SyncResult, "redelivered" | "pulls">): string {
  if (!redelivered && !pulls) return "Up to date with GitHub";
  const done = [
    redelivered && `${plural(redelivered, "missed delivery", "missed deliveries")} asked again`,
    pulls && `${plural(pulls, "pull request")} updated`,
  ].filter(Boolean);
  return `Synced: ${done.join(", ")}`;
}

// Its state: syncing, what it did (said for a few seconds), and the action. `recorded`: the
// sync took place (failed or not), so the state's last sync has it now. The dashboard's one
// (App.tsx): the sidebar's button and Ctrl K both run it.
export type Syncer = ReturnType<typeof useSync>;

export function useSync(onSynced?: () => Promise<void>) {
  const [syncing, setSyncing] = useState(false);
  const [said, setSaid] = useState<{ text: string; failed: boolean; recorded: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(null), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [said]);

  const sync = async () => {
    setSyncing(true);
    setSaid(null);
    const body = await postJson<SyncResult>("api/sync");
    // Done, or failed and recorded as the last sync (its `at`): the state has it now. Refused
    // (synced a moment ago, signed out): nothing changed.
    const recorded = typeof body.at === "number";
    if (body.error) setSaid({ text: `Couldn't sync (${body.error})`, failed: true, recorded });
    else setSaid({ text: syncMessage(body), failed: false, recorded });
    if (recorded) await onSynced?.();
    setSyncing(false);
  };
  return { syncing, said, sync };
}
