import { useEffect, useState } from "preact/hooks";
import { getJson } from "./api";
import { runKindName } from "./format";
import { locale, t } from "./i18n";
import type { RunData, RunDimension, RunMetrics } from "./types";
import { Field } from "./ui/Field";
import { Button } from "./ui/Button";
import styles from "./RunData.module.css";

const dimensions: RunDimension[] = ["repo", "agent", "model", "effort", "user"];
const number = (n: number) => n.toLocaleString(locale(), { maximumFractionDigits: 1 });
const ratio = (n: number, d: number) => (d ? number(n / d) : "—");
// A step as the run history names it: why the listener started it, or its mode.
const stepName = (step: string) =>
  ({
    conflict: t("runName.conflict"),
    "review-fix": t("runName.reviewFix"),
    "ci-fix": t("runName.ciFix"),
  })[step] ?? runKindName(step);
const rate = (n: number, d: number) => `${n}/${d}${d ? ` (${number((n / d) * 100)}%)` : ""}`;

export function RunDataPanel({ repo, task }: { repo: string; task?: string }) {
  const [filters, setFilters] = useState<Partial<Record<RunDimension, string>>>({ repo });
  const [days, setDays] = useState(task ? "all" : "30");
  const [options, setOptions] = useState<RunData["options"] | null>(null);
  const [revision, setRevision] = useState(0);
  const [step, setStep] = useState("");
  const [data, setData] = useState<RunData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setFilters({ repo }), [repo]);
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  if (task) query.set("task", task);
  const selection = query.toString();
  useEffect(() => {
    let current = true;
    setData(null);
    setError(null);
    const params = new URLSearchParams(selection);
    if (days !== "all") params.set("from", String(Date.now() - Number(days) * 86400000));
    getJson<RunData>(`api/run-data?${params}`).then((answer) => {
      if (!current) return;
      if (answer.error) setError(answer.error);
      else {
        setData(answer);
        setOptions(answer.options);
      }
    });
    return () => {
      current = false;
    };
  }, [selection, days, revision]);
  return (
    <section class={`${styles.panel} ${task ? styles.task : ""}`} aria-label={t("runData.title")}>
      {!task && <h2>{t("runData.title")}</h2>}
      <p>{t("runData.intro")}</p>
      <details>
        <summary>{t("runData.method")}</summary>
        <p>{t("runData.caveat")}</p>
      </details>
      <div class={styles.filters}>
        {!task &&
          dimensions.map((d) => (
            <Field
              key={d}
              as="select"
              label={t(`runData.${d}`)}
              value={filters[d] ?? ""}
              onChange={(e) => setFilters({ ...filters, [d]: e.currentTarget.value })}
            >
              <option value="">{t("runData.all")}</option>
              {[...new Set([...(options?.[d] ?? []), ...(filters[d] ? [filters[d]!] : [])])].map(
                (v) => (
                  <option key={v} value={v}>
                    {v === "unknown" ? t("runData.unknown") : v}
                  </option>
                ),
              )}
            </Field>
          ))}
        <Field
          as="select"
          label={t("runData.period")}
          value={days}
          onChange={(e) => setDays(e.currentTarget.value)}
        >
          <option value="7">{t("runData.days7")}</option>
          <option value="30">{t("runData.days30")}</option>
          <option value="90">{t("runData.days90")}</option>
          <option value="all">{t("runData.retained")}</option>
        </Field>
        {task && (
          <Field
            as="select"
            label={t("runData.step")}
            value={step}
            onChange={(e) => setStep(e.currentTarget.value)}
          >
            <option value="">{t("runData.all")}</option>
            {(data?.steps ?? []).map((s) => (
              <option key={s.step} value={s.step}>
                {stepName(s.step)}
              </option>
            ))}
          </Field>
        )}
        <Button onClick={() => setRevision(revision + 1)}>{t("runData.refresh")}</Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">{t("runData.loading")}</p>}
      {data && (
        <>
          {!data.total.runs ? (
            <p>{t("runData.empty")}</p>
          ) : (
            <>
              <Metrics metrics={(task && data.steps.find((s) => s.step === step)) || data.total} />
              <div class={styles.scroll} tabIndex={0} role="region" aria-label={t("runData.steps")}>
                <table>
                  <caption>{t("runData.steps")}</caption>
                  <thead>
                    <tr>
                      <th>{t("runData.step")}</th>
                      <th>{t("runData.runs")}</th>
                      <th>{t("runData.tokens")}</th>
                      <th>{t("runData.coverage")}</th>
                      <th>{t("runData.needsInput")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.steps.map((s) => (
                      <tr key={s.step}>
                        <th scope="row">{stepName(s.step)}</th>
                        <td>{s.runs}</td>
                        <td>{s.usageRuns ? number(s.tokens) : "—"}</td>
                        <td>
                          {s.usageRuns}/{s.runs}
                        </td>
                        <td>{rate(s.needsInput, s.runs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!task && (
                <div class={styles.groups}>
                  {data.groups.map((g) => (
                    <article key={JSON.stringify(g.dimensions)}>
                      <h3>
                        {dimensions
                          .map((d) =>
                            g.dimensions[d] === "unknown" ? t("runData.unknown") : g.dimensions[d],
                          )
                          .join(" · ")}
                      </h3>
                      <Metrics metrics={g} />
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
function Metrics({ metrics: m }: { metrics: RunMetrics }) {
  const rows = [
    [t("runData.runsPerIssue"), `${ratio(m.runs, m.issues)} (${m.runs}/${m.issues})`],
    [t("runData.tokensPerIssue"), ratio(m.tokens, m.usageIssues)],
    [t("runData.coverage"), `${m.usageRuns}/${m.runs}`],
    [t("runData.needsInput"), rate(m.needsInput, m.runs)],
    [
      t("runData.findings"),
      `${ratio(m.findings, m.reviewedPulls)} (${m.findings}/${m.reviewedPulls})`,
    ],
    [t("runData.fixes"), `${m.fixes} / ${m.ciFixes}`],
    [t("runData.merged"), rate(m.merged, m.pullRequests)],
    [t("runData.unchanged"), rate(m.unchanged, m.pullRequests)],
    [t("runData.afterFixes"), String(m.mergedAfterFixes)],
    [t("runData.changed"), String(m.changed)],
    [t("runData.unknownMerge"), String(m.unknownMerge)],
    [t("runData.closed"), String(m.closed)],
  ];
  return (
    <dl class={styles.metrics}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
