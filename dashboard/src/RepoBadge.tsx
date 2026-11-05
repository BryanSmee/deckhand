// A repository's status (api/repos) as a badge: in the list (Repos.tsx) and atop its config
// (ConfigPanel.tsx).
import type { Tone } from "./format";
import { REPO_LABELS } from "./format";
import { t } from "./i18n";
import type { RepoStatus } from "./types";
import { StatusBadge } from "./ui/Status";

const TONES: Record<RepoStatus, Tone> = {
  configured: "done",
  invalid: "err",
  onboarding: "run",
  "not-onboarded": "idle",
  unknown: "idle",
};

export function RepoBadge({ status, class: extra }: { status: RepoStatus; class?: string }) {
  return (
    <StatusBadge
      tone={TONES[status]}
      label={t(REPO_LABELS[status])}
      pulse={status === "onboarding"}
      class={extra}
    />
  );
}
