// One repository's run slots (State.repoSlots, #639): a meter and "1 of 2 running · 3 queued",
// in its page's header, atop its pages on a phone and on its Overview card. Nothing when the
// listener sends none for it (none queued nor running there yet, or a listener from before it).
import styles from "./RepoSlots.module.css";
import { repoSlotsLabel, repoSlotsOf, repoSlotsText } from "./format";
import type { State } from "./types";
import { Meter } from "./ui/Meter";

export function RepoSlots({
  state,
  repo,
  form = "inline",
  class: extra,
}: {
  state: Pick<State, "repoSlots"> | null;
  repo: string;
  // `inline`: the header's, the meter beside its text; `card`: the same, its text wrapping;
  // `bar`: a phone's, a strip atop the page.
  form?: "inline" | "card" | "bar";
  class?: string;
}) {
  const slots = repoSlotsOf(state, repo);
  if (!slots) return null;
  const text = repoSlotsText(slots);
  return (
    <div class={[styles.slots, styles[form], extra].filter(Boolean).join(" ")}>
      <Meter
        running={slots.running}
        max={slots.max}
        label={repoSlotsLabel(repo, slots)}
        title={text}
        class={styles.meter}
      />
      <span class={styles.text} title={text}>
        {text}
      </span>
    </div>
  );
}
