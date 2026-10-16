// A repository's status (api/repos) as a badge: in the list (Repos.tsx) and atop its config
// (ConfigPanel.tsx).
import { REPO_LABELS } from "./format";
import type { RepoStatus } from "./types";
import controls from "./controls.module.css";

const TONES: Record<RepoStatus, string> = {
  configured: controls.ok,
  invalid: controls.err,
  onboarding: controls.run,
  "not-onboarded": controls.accent,
  unknown: controls.idle,
};

export function RepoBadge({ status, class: extra = "" }: { status: RepoStatus; class?: string }) {
  return (
    <span class={`${controls.pill} ${controls.badge} ${TONES[status]} ${extra}`}>
      {REPO_LABELS[status]}
    </span>
  );
}
