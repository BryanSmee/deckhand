// A task's Policies tab: what the repo's policies decided about its pull request, newest first
// (listener/decisions.mjs), and why; a summary when the newest auto-merge was denied, the last
// `/mode policy` dry run, and a link to the repository's policies.
import { dayTime, plural } from "./format";
import { formatRoute } from "./route";
import type { PolicyDecision, Task } from "./types";
import { buttonClass } from "./ui/Button";
import * as Icon from "./ui/icons";
import { StatusBadge } from "./ui/Status";
import { Card } from "./ui/Surface";
import styles from "./Policies.module.css";

const DECISIONS: Record<PolicyDecision["decision"], string> = {
  merge: "Auto-merge",
  review: "Automatic review",
  fix: "Fix run",
  link_branch: "Linked branch",
};

// listener/decisions.mjs MAX_DECISIONS and KEEP_MS.
const KEPT = 10;
const KEPT_DAYS = 90;

// A policy that failed (didn't compile, timed out) is one "policy error: …" message: denied,
// failing closed, but not what a rule said.
export const isPolicyError = (d: PolicyDecision) =>
  d.denied && d.messages.some((m) => /^policy error/i.test(m));

// The newest merge decision about the task's pull request, when it was denied and the pull
// request is still open: a policy, not Deckhand's review, keeps it for a human. The decisions
// are the task's (its issue's), so they may be about an earlier pull request of the same issue.
export function heldMerge(t: Pick<Task, "decisions" | "pr">): PolicyDecision | null {
  const pr = t.pr;
  if (!pr || (pr.state !== "draft" && pr.state !== "ready")) return null;
  const merge = t.decisions?.find((d) => d.decision === "merge" && d.pr === pr.number);
  return merge?.denied ? merge : null;
}

export function PolicyTab({ task: t, now }: { task: Task; now: number }) {
  const decisions = t.decisions ?? [];
  const held = heldMerge(t);
  // The newest denied decision starts open.
  const first = decisions.find((d) => d.denied);
  return (
    <div class={styles.tab}>
      <div class={styles.page}>
        <div class={styles.main}>
          {held && t.pr && <Held decision={held} url={t.pr.url} now={now} />}
          <Card as="section" class={styles.list} aria-label="Policy decisions, newest first">
            {decisions.map((d) => (
              <Decision
                key={`${d.at}-${d.rule}`}
                decision={d}
                open={d === first}
                // A linked branch is the task's own issue's, never another's.
                own={d.decision === "link_branch" || d.pr === t.pr?.number}
                now={now}
              />
            ))}
          </Card>
          <p class={styles.note}>
            The last {KEPT} decisions are kept per task, for {KEPT_DAYS} days.
          </p>
        </div>
        <aside class={styles.side} aria-label="Policies">
          <Card as="section" class={styles.card}>
            <b>Dry run</b>
            <span class={styles.text}>
              Comment <code class={styles.command}>Deckhand /mode policy</code> on the pull request
              to check every rule on its current state. Nothing is reviewed, fixed or merged.
            </span>
            <span class={styles.note}>
              {t.dryRun ? (
                <>
                  Last one: {t.dryRun.by && `by @${t.dryRun.by} `}
                  {dayTime(t.dryRun.at, now)} · {plural(t.dryRun.denials, "denial")}
                  {t.dryRun.url && (
                    <>
                      {" · "}
                      <a href={t.dryRun.url} target="_blank" rel="noreferrer">
                        its reply ↗
                      </a>
                    </>
                  )}
                </>
              ) : (
                "None yet on this pull request."
              )}
            </span>
          </Card>
          <Card as="section" class={styles.card}>
            <b>The rules</b>
            <span class={styles.text}>
              The policy files that apply to {t.repo}, and their errors.
            </span>
            <a
              class={styles.link}
              href={formatRoute({ ...ROUTE, config: t.repo, configTab: "policies" })}
            >
              {t.repo}'s policies →
            </a>
          </Card>
        </aside>
      </div>
    </div>
  );
}

const ROUTE = { repo: null, task: null, run: null, page: "settings" } as const;

// "A policy kept this pull request for a human", and how to merge it anyway.
function Held({ decision: d, url, now }: { decision: PolicyDecision; url: string; now: number }) {
  const at = dayTime(d.at, now);
  const rule = <code class={styles.key}>{d.rule}</code>;
  const then = isPolicyError(d) ? (
    <>{rule} failed, so it was denied: policies fail closed.</>
  ) : (
    <>
      {rule} returned {plural(d.messages.length, "reason")}.
    </>
  );
  return (
    <Card as="section" class={styles.held}>
      <div class={styles.heldText}>
        <b>A policy kept this pull request for a human</b>
        <span class={styles.text}>
          {d.gates?.length ? (
            <>
              Deckhand's own gates passed {at}; then {then}
            </>
          ) : (
            <>
              {at}: {then}
            </>
          )}
        </span>
      </div>
      <a class={buttonClass("primary")} href={url} target="_blank" rel="noreferrer">
        Merge on GitHub ↗
      </a>
    </Card>
  );
}

// `own`: about the task's current pull request; one about another says which.
function Decision({
  decision: d,
  open,
  own,
  now,
}: {
  decision: PolicyDecision;
  open: boolean;
  own: boolean;
  now: number;
}) {
  const error = isPolicyError(d);
  const verdict = error ? "Policy error" : d.denied ? "Denied" : "Allowed";
  return (
    <details class={styles.decision} open={open}>
      <summary class={styles.summary}>
        <span class={styles.chevron}>
          <Icon.ChevronRight size={14} />
        </span>
        <span class={styles.name}>
          {DECISIONS[d.decision] ?? d.decision}
          {!own && <span class={styles.mono}> of #{d.pr}</span>}
        </span>
        <StatusBadge tone={d.denied ? "err" : "done"} label={verdict} class={styles.verdict} />
        <span class={styles.rule}>
          <code class={styles.key}>{d.rule}</code>
          {d.messages.length > 0 && !error && ` · ${plural(d.messages.length, "reason")}`}
          {error && ` · ${d.messages[0].replace(/^policy error:?\s*/i, "")}: denied, fail closed`}
        </span>
        <span class={styles.when}>{dayTime(d.at, now)}</span>
      </summary>
      <div class={styles.body}>
        {d.messages.length > 0 && (
          <ul class={styles.messages} aria-label="Reasons">
            {d.messages.map((m, i) => (
              <li key={i} class={styles.message}>
                {m}
              </li>
            ))}
          </ul>
        )}
        {!d.messages.length && <p class={styles.note}>No rule denied it.</p>}
        {!!d.gates?.length && (
          <div class={styles.gates}>
            <span class={styles.note}>Built-in gates first:</span>
            {d.gates.map((g) => (
              <span key={g.name} class={`${styles.gate} ${g.passed ? "" : styles.failed}`}>
                {g.passed ? (
                  <Icon.Check size={13} class={styles.passed} />
                ) : (
                  <Icon.Close size={13} class={styles.missed} />
                )}
                {g.name}
              </span>
            ))}
          </div>
        )}
        {d.input !== undefined && <Input decision={d} />}
      </div>
    </details>
  );
}

// The input the rules saw, as folded JSON.
function Input({ decision: d }: { decision: PolicyDecision }) {
  const version = d.input?.version;
  return (
    <details class={styles.input}>
      <summary>
        <span class={styles.chevron}>
          <Icon.ChevronRight size={12} />
        </span>
        The input the rules saw
        {version !== undefined && <span class={styles.mono}>input.version {String(version)}</span>}
        {d.truncated && <span class={styles.note}>cut to fit</span>}
      </summary>
      {d.input ? (
        <pre class={styles.json}>{JSON.stringify(d.input, null, 2)}</pre>
      ) : (
        <p class={styles.note}>Too big to keep, even cut.</p>
      )}
    </details>
  );
}
