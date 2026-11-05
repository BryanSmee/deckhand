// A task's Policies tab: what the repo's policies decided about its pull request, newest first
// (listener/decisions.mjs), and why; a summary when the newest auto-merge was denied, the last
// `/mode policy` dry run, and a link to the repository's policies.
import { dayTime } from "./format";
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
import { formatRoute } from "./route";
import type { PolicyDecision, PolicyLayer, Task } from "./types";
import { buttonClass } from "./ui/Button";
import * as Icon from "./ui/icons";
import { StatusBadge } from "./ui/Status";
import { Card } from "./ui/Surface";
import styles from "./Policies.module.css";

// Keys, written when shown: in the language chosen now.
const DECISIONS: Record<PolicyDecision["decision"], Plain> = {
  run: "policies.run",
  merge: "policies.merge",
  review: "policies.review",
  fix: "policies.fix",
  link_branch: "policies.linkBranch",
  request_review: "policies.requestReview",
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
export function heldMerge(task: Pick<Task, "decisions" | "pr">): PolicyDecision | null {
  const pr = task.pr;
  if (!pr || (pr.state !== "draft" && pr.state !== "ready")) return null;
  const merge = task.decisions?.find((d) => d.decision === "merge" && d.pr === pr.number);
  return merge?.denied ? merge : null;
}

export function PolicyTab({ task, now }: { task: Task; now: number }) {
  const decisions = task.decisions ?? [];
  const held = heldMerge(task);
  // The newest denied decision starts open.
  const first = decisions.find((d) => d.denied);
  // The last dry run, as its line says it.
  const last = task.dryRun && {
    by: task.dryRun.by,
    at: dayTime(task.dryRun.at, now),
    denials: t("policies.denials", { count: task.dryRun.denials }),
    url: task.dryRun.url,
  };
  return (
    <div class={styles.tab}>
      <div class={styles.page}>
        <div class={styles.main}>
          {held && task.pr && <Held decision={held} url={task.pr.url} now={now} />}
          <Card as="section" class={styles.list} aria-label={t("policies.decisions")}>
            {decisions.map((d) => (
              <Decision
                key={`${d.at}-${d.rule}`}
                decision={d}
                open={d === first}
                // A linked branch is the task's own issue's, never another's; a run, the
                // task's own, wherever its comment was.
                own={
                  d.decision === "link_branch" || d.decision === "run" || d.pr === task.pr?.number
                }
                now={now}
              />
            ))}
          </Card>
          <p class={styles.note}>{t("policies.kept", { kept: KEPT, days: KEPT_DAYS })}</p>
        </div>
        <aside class={styles.side} aria-label={t("policies.side")}>
          <Card as="section" class={styles.card}>
            <b>{t("policies.dryRun")}</b>
            <span class={styles.text}>
              {tx("policies.dryRunHelp", {
                command: <code class={styles.command}>Deckhand /mode policy</code>,
              })}
            </span>
            <span class={styles.note}>
              {last ? (
                <>
                  {last.by
                    ? t("policies.lastBy", { by: last.by, at: last.at, denials: last.denials })
                    : t("policies.last", { at: last.at, denials: last.denials })}
                  {last.url && (
                    <>
                      {" · "}
                      <a href={last.url} target="_blank" rel="noreferrer">
                        {t("policies.reply")}
                      </a>
                    </>
                  )}
                </>
              ) : (
                t("policies.noDryRun")
              )}
            </span>
          </Card>
          <Card as="section" class={styles.card}>
            <b>{t("policies.rules")}</b>
            <span class={styles.text}>{t("policies.rulesHelp", { repo: task.repo })}</span>
            <a
              class={styles.link}
              href={formatRoute({ ...ROUTE, config: task.repo, configTab: "policies" })}
            >
              {t("policies.repoPolicies", { repo: task.repo })}
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
  const then = isPolicyError(d)
    ? tx("policies.heldFailed", { rule })
    : tx("policies.heldReturned", { rule, count: d.messages.length });
  return (
    <Card as="section" class={styles.held}>
      <div class={styles.heldText}>
        <b>{t("policies.held")}</b>
        <span class={styles.text}>
          {tx(d.gates?.length ? "policies.heldGates" : "policies.heldAt", { at, then })}
        </span>
      </div>
      <a class={buttonClass("primary")} href={url} target="_blank" rel="noreferrer">
        {t("policies.mergeOnGithub")}
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
  const verdict = t(error ? "policies.error" : d.denied ? "policies.denied" : "policies.allowed");
  // Its two rules, once allow rules are kept with it; its deny rule before.
  const rule = d.layers ? `allow_${d.decision} · deny_${d.decision}` : d.rule;
  return (
    <details class={styles.decision} open={open}>
      <summary class={styles.summary}>
        <span class={styles.chevron}>
          <Icon.ChevronRight size={14} />
        </span>
        <span class={styles.name}>
          {DECISIONS[d.decision] ? t(DECISIONS[d.decision]) : d.decision}
          {!own && <span class={styles.mono}> {t("policies.ofPr", { pr: d.pr })}</span>}
        </span>
        <StatusBadge tone={d.denied ? "err" : "done"} label={verdict} class={styles.verdict} />
        <span class={styles.rule}>
          <code class={styles.key}>{rule}</code>
          {d.messages.length > 0 &&
            !error &&
            ` · ${t("policies.reasons", { count: d.messages.length })}`}
          {error &&
            ` · ${t("policies.failClosed", { error: d.messages[0].replace(/^policy error:?\s*/i, "") })}`}
        </span>
        <span class={styles.when}>{dayTime(d.at, now)}</span>
      </summary>
      <div class={styles.body}>
        {d.messages.length > 0 && (
          <ul class={styles.messages} aria-label={t("policies.reasonsList")}>
            {d.messages.map((m, i) => (
              <li key={i} class={styles.message}>
                {m}
              </li>
            ))}
          </ul>
        )}
        {!d.messages.length && <p class={styles.note}>{t("policies.noDenial")}</p>}
        {!!d.layers?.length && (
          <ul class={styles.layers} aria-label={t("policies.layers")}>
            {d.layers.map((l) => (
              <Layer key={l.layer} decision={d.decision} layer={l} />
            ))}
          </ul>
        )}
        {!!d.gates?.length && (
          <div class={styles.gates}>
            <span class={styles.note}>{t("policies.gatesFirst")}</span>
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

// What a layer said of `decision`: its allow rule's result and its deny rule's, each with the
// files that define it.
function Layer({ decision, layer: l }: { decision: string; layer: PolicyLayer }) {
  // What a rule said, then the files that define it, if any.
  const from = (said: string, files: string[]) =>
    files.length ? t("policies.inFiles", { said, files: files.join(t("list.comma")) }) : said;
  const allow =
    l.allow === null
      ? t("policies.notAsked")
      : from(t(l.allow ? "policies.matched" : "policies.noMatch"), l.allowFiles);
  const deny = from(
    l.denies.length ? t("policies.reasons", { count: l.denies.length }) : t("policies.nothing"),
    l.denyFiles,
  );
  return (
    <li class={styles.layer}>
      <b>{t(l.layer === "repo" ? "policies.repo" : "policies.operator")}</b>
      {l.error ? (
        <span class={styles.text}>{l.error}</span>
      ) : (
        <>
          <span class={`${styles.text} ${l.allow === false ? styles.unallowed : ""}`}>
            <code class={styles.key}>allow_{decision}</code> {allow}
          </span>
          <span class={styles.text}>
            <code class={styles.key}>deny_{decision}</code> {deny}
          </span>
        </>
      )}
    </li>
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
        {t("policies.input")}
        {version !== undefined && <span class={styles.mono}>input.version {String(version)}</span>}
        {d.truncated && <span class={styles.note}>{t("policies.cut")}</span>}
      </summary>
      {d.input ? (
        <pre class={styles.json}>{JSON.stringify(d.input, null, 2)}</pre>
      ) : (
        <p class={styles.note}>{t("policies.tooBig")}</p>
      )}
    </details>
  );
}
