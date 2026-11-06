// A task's Review tab: the last review Deckhand posted on its pull request (GET /api/review),
// read from GitHub when the tab opens and again on a new round or a merge. Its verdict, round,
// rating and reviewed commit, linked to the review on GitHub; then its three sections: Must fix
// by severity, Follow-ups (filed as issues after the merge: each one's issue and its state once
// it is) and Comments (blocking or note). Merged: a banner says by whom, the follow-ups lead and
// the findings left are what it was merged with. Everything the review says is a model's text,
// shown as text: only the links Deckhand builds itself (a place at the reviewed commit, an
// issue) are links.
import { useEffect } from "preact/hooks";
import { useReview } from "./api";
import { dayTime, reviewOutdated, shortSha } from "./format";
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
import type { ReviewFindings, ReviewItem, Severity, Task } from "./types";
import { Button } from "./ui/Button";
import * as Icon from "./ui/icons";
import { Card, Notice, Skeleton } from "./ui/Surface";
import styles from "./ReviewTab.module.css";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const SEVERITY_NAMES: Record<Severity, Plain> = {
  critical: "reviewTab.critical",
  high: "reviewTab.high",
  medium: "reviewTab.medium",
  low: "reviewTab.low",
};
// The severities a review blocks on at all: a low finding never does, tolerated or not.
const BLOCKING: Severity[] = ["critical", "high", "medium"];

const VERDICTS: Record<ReviewFindings["verdict"], Plain> = {
  "request-changes": "reviewTab.requestChanges",
  comment: "reviewTab.comment",
  approve: "reviewTab.approve",
};

// Merged with follow-ups still being filed: read again after this.
const FILING_AGAIN_MS = 10_000;

// What a task's Review tab reads again on: its rounds and its pull request's state.
export const reviewVersion = (task: Task) =>
  `${task.review?.history.length ?? 0}-${task.review?.history.at(-1)?.at ?? 0}-${task.pr?.state ?? ""}`;

export function ReviewTab({ task, now }: { task: Task; now: number }) {
  const { review, error, missing, loading, reload } = useReview(
    task.repo,
    task.pr!.number,
    reviewVersion(task),
  );
  // Merged, its follow-ups' filing on its way: read again in a moment, as nothing in api/state
  // says when it is done.
  const filing = !!review?.merged && review.followUps.some((f) => f.filing === "after-merge");
  useEffect(() => {
    if (!filing) return;
    const again = setTimeout(reload, FILING_AGAIN_MS);
    return () => clearTimeout(again);
  }, [review]);
  if (!review) {
    return (
      <div class={styles.page}>
        {missing ? (
          <p class={styles.none}>{t("reviewTab.missing")}</p>
        ) : error ? (
          <Notice tone="err">
            {t("reviewTab.readFailed", { error: sentence(error) })}{" "}
            <Button size="small" variant="ghost" onClick={reload}>
              {t("reviewTab.tryAgain")}
            </Button>
          </Notice>
        ) : (
          <div class={styles.loading} aria-busy={loading} aria-label={t("reviewTab.reading")}>
            <Skeleton width="40%" height={14} />
            <Skeleton height={60} />
            <Skeleton height={60} />
          </div>
        )}
      </div>
    );
  }
  const merged = review.merged;
  const sections = [
    <MustFix key="fix" review={review} merged={!!merged} />,
    <FollowUps key="follow" review={review} merged={!!merged} />,
    <Comments key="comments" review={review} />,
  ];
  // Merged: what is left to do (the follow-ups) first.
  if (merged) sections.unshift(sections.splice(1, 1)[0]);
  return (
    <div class={styles.page}>
      {merged && (
        <Notice tone="done" class={styles.merged}>
          <MergedBy task={task} merged={merged} now={now} />
        </Notice>
      )}
      <Head task={task} review={review} now={now} />
      {error && (
        <Notice tone="err">
          {t("reviewTab.readAgainFailed", { error: sentence(error) })}{" "}
          <Button size="small" variant="ghost" onClick={reload}>
            {t("reviewTab.tryAgain")}
          </Button>
        </Notice>
      )}
      {sections}
    </div>
  );
}

// "Merged #30 by Deckhand today 14:02".
function MergedBy({
  task,
  merged,
  now,
}: {
  task: Task;
  merged: NonNullable<ReviewFindings["merged"]>;
  now: number;
}) {
  const number = task.pr!.number;
  const who = merged.deckhand ? "Deckhand" : merged.by ? `@${merged.by}` : null;
  const said = who ? t("reviewTab.mergedBy", { number, who }) : t("reviewTab.merged", { number });
  return (
    <>
      {merged.at ? t("reviewTab.mergedAt", { merged: said, when: dayTime(merged.at, now) }) : said}
    </>
  );
}

// "Requests changes · R2 · 6/10 · reviewed abc1234 · today 14:02 · On GitHub ↗", and the
// Outdated mark once a commit was pushed after it.
function Head({ task, review, now }: { task: Task; review: ReviewFindings; now: number }) {
  const outdated = reviewOutdated(task);
  const blocks = review.verdict === "request-changes";
  return (
    <header class={styles.head}>
      <span class={blocks ? styles.changes : styles.verdict}>{t(VERDICTS[review.verdict])}</span>
      {/* A maintainer's review counts no fix round: no R<n>, as the review loop's list. */}
      {review.manual ? (
        <span class={styles.fact}>{t("reviewTab.maintainer")}</span>
      ) : (
        review.round !== null && (
          <span
            class={styles.round}
            title={
              review.round
                ? t("reviewTab.afterRound", { round: review.round })
                : t("reviewTab.first")
            }
          >
            {t("reviewTab.round", { round: review.round })}
          </span>
        )
      )}
      <span class={styles.fact}>{t("reviewTab.rating", { rating: review.rating })}</span>
      {review.head && (
        <span class={styles.fact}>
          {tx("reviewTab.reviewed", {
            sha: (
              <a
                class={styles.sha}
                href={`${task.pr!.url}/commits/${review.head}`}
                target="_blank"
                rel="noreferrer"
              >
                {shortSha(review.head)}
              </a>
            ),
          })}
        </span>
      )}
      {review.at && <span class={styles.fact}>{dayTime(review.at, now)}</span>}
      {outdated && outdated.reviewed === review.head && (
        <span class={styles.outdated}>
          <Icon.Warning size={13} />
          {tx("reviewTab.outdated", {
            head: <span class={styles.sha}>{shortSha(outdated.head)}</span>,
          })}
        </span>
      )}
      {review.url && (
        <a class={styles.github} href={review.url} target="_blank" rel="noreferrer">
          {t("reviewTab.github")}
          <Icon.External size={12} />
        </a>
      )}
    </header>
  );
}

function MustFix({ review, merged }: { review: ReviewFindings; merged: boolean }) {
  const n = review.findings.length;
  return (
    <Card as="section" class={styles.section} aria-label={t("reviewTab.mustFix")}>
      <h3>
        {t("reviewTab.mustFix")} <span class={styles.count}>{n}</span>
      </h3>
      {!n && <p class={styles.none}>{t("reviewTab.nothingToFix")}</p>}
      {SEVERITIES.map((s) => {
        const found = review.findings.filter((f) => f.severity === s);
        if (!found.length) return null;
        return (
          <div key={s} class={styles.group}>
            <h4>
              <span class={`${styles.dot} ${styles[s]}`} aria-hidden="true" />
              {t(SEVERITY_NAMES[s])} <span class={styles.count}>{found.length}</span>
            </h4>
            <ul class={styles.items}>
              {found.map((f, i) => (
                <li key={i}>
                  <div class={styles.line}>
                    <Place item={f} blob={review.blob} />
                    {merged ? (
                      <span class={styles.mark}>{t("reviewTab.mergedWith")}</span>
                    ) : f.tolerated ? (
                      // `allowed`: the repo's config value, as its file writes it, not translated.
                      <span
                        class={styles.mark}
                        title={t("reviewTab.toleratedHelp", { severity: review.allowed })}
                      >
                        {t("reviewTab.tolerated")}
                      </span>
                    ) : (
                      BLOCKING.includes(s) && <span class={styles.fix}>{t("reviewTab.toFix")}</span>
                    )}
                  </div>
                  <Text text={f.text} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </Card>
  );
}

const FILINGS: Record<Exclude<ReviewFindings["followUps"][number]["filing"], "issue">, Plain> = {
  "after-merge": "reviewTab.filingAfterMerge",
  failed: "reviewTab.filingFailed",
  left: "reviewTab.filingLeft",
  off: "reviewTab.filingOff",
  unread: "reviewTab.filingUnread",
  "not-filed": "reviewTab.filingNotFiled",
  unknown: "reviewTab.filingUnknown",
};

function FollowUps({ review, merged }: { review: ReviewFindings; merged: boolean }) {
  const n = review.followUps.length;
  // A review from before the sections has none: no section.
  if (!n) return null;
  return (
    <Card as="section" class={styles.section} aria-label={t("reviewTab.followUps")}>
      <h3>
        {t("reviewTab.followUps")} <span class={styles.count}>{n}</span>
      </h3>
      <p class={styles.note}>
        {merged ? t("reviewTab.followUpsMerged") : t("reviewTab.followUpsOpen")}
      </p>
      <ul class={styles.items}>
        {review.followUps.map((f, i) => (
          <li key={i}>
            <div class={styles.line}>
              <b class={styles.title}>{f.title}</b>
              {f.issue ? (
                <span class={styles.issue}>
                  {f.issue.url ? (
                    <a href={f.issue.url} target="_blank" rel="noreferrer">
                      #{f.issue.number}
                    </a>
                  ) : (
                    `#${f.issue.number}`
                  )}
                  {f.issue.state && (
                    <span class={f.issue.state === "open" ? styles.open : styles.closed}>
                      {f.issue.state === "open"
                        ? t("reviewTab.issueOpen")
                        : t("reviewTab.issueClosed")}
                    </span>
                  )}
                </span>
              ) : (
                <span
                  class={
                    f.filing === "failed" || f.filing === "not-filed" ? styles.failed : styles.mark
                  }
                >
                  {f.filing in FILINGS ? t(FILINGS[f.filing as keyof typeof FILINGS]) : f.filing}
                </span>
              )}
            </div>
            {f.path && <Place item={f} blob={review.blob} />}
            <Text text={f.text} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Comments({ review }: { review: ReviewFindings }) {
  const n = review.comments.length;
  if (!n) return null;
  return (
    <Card as="section" class={styles.section} aria-label={t("reviewTab.comments")}>
      <h3>
        {t("reviewTab.comments")} <span class={styles.count}>{n}</span>
      </h3>
      <ul class={styles.items}>
        {review.comments.map((c, i) => (
          <li key={i}>
            <div class={styles.line}>
              <span class={c.blocking ? styles.fix : styles.mark}>
                {c.blocking ? t("reviewTab.blocking") : t("reviewTab.note")}
              </span>
              <Place item={c} blob={review.blob} />
            </div>
            <Text text={c.text} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

// `path:line`, linked to that line at the reviewed commit when known.
function Place({ item, blob }: { item: ReviewItem; blob: string | null }) {
  if (!item.path) return null;
  const label = item.line ? `${item.path}:${item.line}` : item.path;
  if (!blob) return <code class={styles.place}>{label}</code>;
  // "." and ".." dropped: the link stays in the tree at the reviewed commit.
  const path = item.path
    .split("/")
    .filter((p) => p && p !== "." && p !== "..")
    .map(encodeURIComponent)
    .join("/");
  return (
    <a
      class={styles.place}
      href={`${blob}/${path}${item.line ? `#L${item.line}` : ""}`}
      target="_blank"
      rel="noreferrer"
    >
      {label}
    </a>
  );
}

// A message as one sentence: its own period, or one added.
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

// A model's text, as it wrote it: HTML and markdown links stay literal.
function Text({ text }: { text: string }) {
  if (!text) return null;
  return <p class={styles.text}>{text}</p>;
}
