// A repository's status (api/repos) as a badge: in the list (Repos.tsx) and atop its config
// (ConfigPanel.tsx).
import type { Tone } from "./format";
import { REPO_LABELS } from "./format";
import type { RepoStatus } from "./types";
import { StatusBadge } from "./ui/Status";

const TONES: Record<RepoStatus, Tone> = {
  configured: "done",
  invalid: "err",
  onboarding: "run",
  "not-onboarded": "input",
  unknown: "idle",
};

export function RepoBadge({ status, class: extra }: { status: RepoStatus; class?: string }) {
  return <StatusBadge tone={TONES[status]} label={REPO_LABELS[status]} class={extra} />;
}
