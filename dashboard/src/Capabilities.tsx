// A repository's Capabilities tab: what each mode's runs get at their start (listener/
// capabilities.mjs), decided by the policies, greedily (allowed, asked for by .deckhand.yaml
// when a key asks for it, granted when a grant gates it), with the file that decided each one;
// what would stop a mode's runs (a broken dependency, a risky combination, a grant missing) and
// the warnings; then the catalogue. Read with the config (api/repos/<repo>/config).
import { plural, type Tone } from "./format";
import type { CapabilityInfo, CapabilityRow, ModeCapabilities, RepoConfig } from "./types";
import { Alert, ChevronRight, Warning } from "./ui/icons";
import { StatusBadge } from "./ui/Status";
import styles from "./Capabilities.module.css";

const DOCS = "https://github.com/BryanSmee/deckhand/blob/main/docs/repo-config.md#capabilities";

// What a capability's status says, as its row in a mode's details shows it.
const STATUSES: Record<CapabilityRow["status"], [string, Tone]> = {
  used: ["Used", "done"],
  denied: ["Denied", "err"],
  "not-allowed": ["Not allowed", "idle"],
  "not-asked": ["Not asked for", "idle"],
  "not-granted": ["Not granted", "input"],
};

// The files that decided a row, as "mode-work.rego" or "repo: audit.rego".
const fileName = ({ layer, file }: CapabilityRow["files"][number]) =>
  file ?? `a rule of the ${layer === "repo" ? "repo's" : "operator's"}`;
const filesOf = (row: CapabilityRow) =>
  row.files.map((f) => (f.layer === "repo" ? `repo: ${fileName(f)}` : fileName(f))).join(", ");

// The modes whose runs wouldn't start, for the header's badge: null when every one starts.
export function capabilityTrouble({ capabilities }: RepoConfig): string | null {
  if (capabilities.error) return "Capabilities: policy error";
  const stopped = capabilities.modes.filter((m) => m.errors.length).length;
  return stopped ? `${plural(stopped, "mode")} can't run` : null;
}

export function Capabilities({ config }: { config: RepoConfig }) {
  const { catalogue, modes, error } = config.capabilities;
  return (
    <div class={styles.page}>
      {error && (
        <section class={styles.banner} role="alert">
          <Alert size={18} />
          <div class={styles.bannerText}>
            <b>The policies can't decide what runs get: no run starts</b>
            <span>{error}</span>
          </div>
        </section>
      )}
      <p class={styles.model}>
        At its start, a run gets each capability an <b>allow</b> rule of the policies gives (
        <code>allow_capabilities</code>) and no <b>deny</b> rule refuses (
        <code>deny_capabilities</code>), when <code>.deckhand.yaml</code> asks for it if a key does,
        and the operator's grant gives it if one gates it. Beyond these, every run has its sandbox,
        the agent's API and its prompt, nothing of the repository's. Shown for a run a comment
        starts on an issue, not a fork's: a policy may decide otherwise for a pull request, a fork's
        or a fix run.{" "}
        <a href={DOCS} target="_blank" rel="noreferrer">
          How capabilities work
        </a>
      </p>
      {modes.length > 0 && (
        <section class={styles.card} aria-labelledby="capability-modes">
          <div class={styles.cardHead}>
            <h2 id="capability-modes">What each mode's runs get</h2>
            <span class={styles.note}>
              {plural(modes.length, "mode")} · read from <code>{config.base}</code>
            </span>
          </div>
          <ul class={styles.modes}>
            {modes.map((m) => (
              <Mode key={m.mode} mode={m} />
            ))}
          </ul>
        </section>
      )}
      <Catalogue catalogue={catalogue} />
    </div>
  );
}

// A mode: whether its runs start, the capabilities they get and the files that gave them, what
// stops them and the warnings, then every capability, folded.
function Mode({ mode: m }: { mode: ModeCapabilities }) {
  const used = m.capabilities.filter((c) => c.used);
  const files = [...new Set(used.flatMap((c) => c.files.map(fileName)))];
  const [tone, label]: [Tone, string] = m.errors.length
    ? ["err", "Doesn't start"]
    : m.warnings.length
      ? ["input", "Starts, with warnings"]
      : ["done", "Starts"];
  return (
    <li class={styles.mode} aria-label={`The ${m.mode} mode`}>
      <div class={styles.modeHead}>
        <span class={styles.modeName}>
          <span class={styles.key}>{m.mode}</span>
          {m.custom && <span class={styles.tag}>repo's own</span>}
        </span>
        <StatusBadge tone={tone} label={label} />
      </div>
      <div class={styles.chips} aria-label="Its capabilities">
        {used.length ? (
          used.map((c) => (
            <span key={c.name} class={styles.chip} title={`Allowed by ${filesOf(c)}`}>
              {c.name}
            </span>
          ))
        ) : (
          <span class={styles.note}>Nothing of the repository's</span>
        )}
      </div>
      {files.length > 0 && <span class={styles.note}>Decided by {files.join(", ")}</span>}
      {m.errors.length > 0 && (
        <ul class={styles.errors} aria-label="What stops its runs">
          {m.errors.map((e) => (
            <li key={e}>
              <Alert size={14} />
              {e}
            </li>
          ))}
        </ul>
      )}
      {m.warnings.length > 0 && (
        <ul class={styles.warnings} aria-label="Warnings">
          {m.warnings.map((w) => (
            <li key={w}>
              <Warning size={14} />
              {w}
            </li>
          ))}
        </ul>
      )}
      <details class={styles.details}>
        <summary>
          <span class={styles.chevron}>
            <ChevronRight size={14} />
          </span>
          Every capability
        </summary>
        <ul class={styles.rows}>
          {m.capabilities.map((c) => {
            const [name, tone] = STATUSES[c.status];
            return (
              <li key={c.name} class={styles.row}>
                <span class={styles.key}>{c.name}</span>
                <StatusBadge tone={tone} label={name} />
                <span class={styles.why}>
                  {[c.reason, c.files.length ? filesOf(c) : null].filter(Boolean).join(" · ") ||
                    "—"}
                </span>
              </li>
            );
          })}
        </ul>
      </details>
    </li>
  );
}

// The capabilities Deckhand knows: what each gives, what it needs, what asks for it in
// .deckhand.yaml, the grant that gates it and what enforces it.
function Catalogue({ catalogue }: { catalogue: CapabilityInfo[] }) {
  return (
    <section class={styles.card} aria-labelledby="capability-catalogue">
      <div class={styles.cardHead}>
        <h2 id="capability-catalogue">The capabilities</h2>
        <span class={styles.note}>
          A run whose capabilities miss one they need doesn't start; nor one with <code>pull</code>{" "}
          of a private repository and <code>internet</code>, unless the operator's policies give{" "}
          <code>pull+internet</code>.
        </span>
      </div>
      <div class={`${styles.entry} ${styles.entryHead}`} aria-hidden="true">
        <span>Capability</span>
        <span>Gives</span>
        <span>Needs</span>
        <span>Asked by</span>
        <span>Enforced by</span>
      </div>
      <ul class={styles.entries} aria-label="The catalogue">
        {catalogue.map((c) => (
          <li key={c.name} class={styles.entry}>
            <span class={styles.key}>{c.name}</span>
            <span class={styles.what}>{c.what}</span>
            <span class={styles.needs}>{c.needs.length ? c.needs.join(", ") : "—"}</span>
            <span class={styles.asked}>
              {c.config.length ? c.config.join(" or ") : "the policies alone"}
              {c.grant && <span class={styles.note}> · grant {c.grant}</span>}
            </span>
            <span class={styles.enforced}>{c.enforcedBy}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
