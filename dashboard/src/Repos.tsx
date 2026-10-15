// The repositories the App is installed on: which have a .deckhand.yaml, which are being
// onboarded (with their issue), and a button that starts onboarding on the others.
import type { RepoList } from "./api";
import type { Repo, RepoStatus } from "./types";
import styles from "./Repos.module.css";

const LABELS: Record<RepoStatus, string> = {
  configured: "Configured",
  onboarding: "Onboarding",
  "not-onboarded": "Not onboarded",
  unknown: "Unknown",
};

// The ones that need the maintainer first, then by name (the listener sorts by name).
const ORDER: RepoStatus[] = ["not-onboarded", "onboarding", "unknown", "configured"];

export function notOnboarded(repos: Repo[] | null): number {
  return repos?.filter((r) => r.status === "not-onboarded").length ?? 0;
}

interface Props {
  list: RepoList;
  onBack: () => void;
}

export function Repos({ list, onBack }: Props) {
  const { repos, error, starting, failed, onboard } = list;
  const sorted = [...(repos ?? [])].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status),
  );
  const waiting = notOnboarded(repos);
  return (
    <section class={styles.page} aria-labelledby="repos-title">
      <div class={styles.head}>
        <button type="button" class={styles.back} onClick={onBack}>
          ← Runs
        </button>
        <h2 id="repos-title">Repositories</h2>
        <p class={styles.lead}>
          Where the App is installed and <code>ALLOWED_REPOS</code> lets it run.
          {repos &&
            (waiting
              ? ` ${waiting} without a .deckhand.yaml: onboarding opens an issue where Claude proposes one.`
              : " All of them are set up or being onboarded.")}
        </p>
      </div>
      {error && <p class={styles.error}>Can't list the repositories ({error}).</p>}
      {!repos && !error && <p class={styles.empty}>Loading…</p>}
      {repos?.length === 0 && (
        <p class={styles.empty}>The App isn't installed on any allowed repository yet.</p>
      )}
      {sorted.length > 0 && (
        <ul class={styles.rows}>
          {sorted.map((r) => (
            <li key={r.repo} class={styles.row}>
              <div class={styles.name}>
                <a href={r.url} target="_blank" rel="noreferrer" title={r.repo}>
                  {r.repo}
                </a>
                {r.private && <span class={styles.private}>private</span>}
              </div>
              <span class={`${styles.status} ${styles[r.status]}`}>{LABELS[r.status]}</span>
              <div class={styles.action}>
                {r.status === "onboarding" && r.issue && (
                  <a href={r.issue.url} target="_blank" rel="noreferrer">
                    Issue #{r.issue.number}
                  </a>
                )}
                {r.status === "not-onboarded" &&
                  (r.issues ? (
                    <button
                      type="button"
                      class={styles.start}
                      disabled={starting !== null}
                      onClick={() => onboard(r.repo)}
                    >
                      {starting === r.repo ? "Starting…" : "Start onboarding"}
                    </button>
                  ) : (
                    <span class={styles.note}>Issues are disabled: can't be onboarded</span>
                  ))}
                {r.status === "unknown" && (
                  <span class={styles.note}>GitHub didn't answer: see the listener's logs</span>
                )}
              </div>
              {failed?.repo === r.repo && (
                <p class={styles.failed} role="alert">
                  {failed.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
