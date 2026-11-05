// Settings › Preferences (docs/design/dashboard-redesign.md › Pages › Settings › Preferences): the
// choices kept in this browser (prefs.ts), in four groups. Each changes the page at once, here and
// wherever it applies; the browser's notification permission is the browser's, asked from here too.
import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { t, tx } from "./i18n";
import { browserLanguages, CATALOGS, LANGUAGES, type Plain, resolveLanguage } from "./locales";
import type { Notify } from "./notify";
import { type LanguageChoice, type PrefName, type Prefs, usePref } from "./prefs";
import { Button } from "./ui/Button";
import { type Segment, Segmented, Switch } from "./ui/Choice";
import { Field } from "./ui/Field";
import { Kbd } from "./ui/Kbd";
import styles from "./Preferences.module.css";

// Written when shown: in the language chosen now.
const words = <T extends string>(...pairs: [T, Plain][]): Segment<T>[] =>
  pairs.map(([value, label]) => ({ value, label: t(label) }));

// A preference's row: its name and what it does, then its control.
function Row({
  title,
  help,
  children,
}: {
  title: ComponentChildren;
  help: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <div class={styles.pref}>
      <span class={styles.text}>
        <b>{title}</b>
        <span>{help}</span>
      </span>
      {children}
    </div>
  );
}

type Choice = "theme" | "density" | "motion" | "phoneBoard";

function Choose<K extends Choice>({
  name,
  title,
  help,
  options,
}: {
  name: K;
  title: Plain;
  help: Plain;
  options: Segment<Prefs[K]>[];
}) {
  const [value, set] = usePref(name);
  return (
    <Row title={t(title)} help={t(help)}>
      <Segmented label={t(title)} options={options} value={value} onChange={set} />
    </Row>
  );
}

type Flag = { [K in PrefName]: Prefs[K] extends boolean ? K : never }[PrefName];

// The whole row is the switch's label; the help describes it.
function Toggle({ name, title, help }: { name: Flag; title: Plain; help: ComponentChildren }) {
  const [on, set] = usePref(name);
  const id = useId();
  return (
    <Switch
      large
      class={`${styles.pref} ${styles.toggle}`}
      checked={on}
      onChange={set}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-help`}
      label={
        <span class={styles.text}>
          <b id={`${id}-title`}>{t(title)}</b>
          <span id={`${id}-help`}>{help}</span>
        </span>
      }
    />
  );
}

function Group({ title, children }: { title: Plain; children: ComponentChildren }) {
  const id = useId();
  return (
    <section class={styles.group} aria-labelledby={id}>
      <h2 id={id}>{t(title)}</h2>
      {children}
    </section>
  );
}

const PERMISSIONS: Record<Notify["permission"], { text: Plain; tone?: string }> = {
  granted: { text: "prefs.granted", tone: styles.allowed },
  default: { text: "prefs.default" },
  denied: { text: "prefs.denied", tone: styles.blocked },
  unsupported: { text: "prefs.unsupported" },
};

function Permission({ notify }: { notify: Notify }) {
  const { text, tone } = PERMISSIONS[notify.permission];
  return (
    <Row
      title={t("prefs.browserNotifications")}
      help={
        <>
          {t("prefs.browserHelp")} <span class={tone}>{t(text)}</span>
        </>
      }
    >
      {notify.permission === "default" ? (
        <Button onClick={() => void notify.ask()}>{t("prefs.allow")}</Button>
      ) : (
        <Button disabled={notify.permission !== "granted"} onClick={notify.test}>
          {t("prefs.test")}
        </Button>
      )}
    </Row>
  );
}

// System, then each language in its own name and language: whoever can't read the page now
// still finds theirs. System says which one it comes to.
function Language() {
  const [choice, set] = usePref("language");
  const system = resolveLanguage("system", browserLanguages()).language;
  const name = (code: keyof typeof CATALOGS) => CATALOGS[code]["language.name"];
  return (
    <Row title={t("prefs.language")} help={t("prefs.languageHelp")}>
      <Field
        as="select"
        label={t("prefs.language")}
        hideLabel
        class={styles.select}
        value={choice}
        onChange={(e) => set(e.currentTarget.value as LanguageChoice)}
      >
        <option value="system">{t("prefs.languageSystem", { name: name(system) })}</option>
        {LANGUAGES.map((code) => (
          <option key={code} value={code} lang={code}>
            {name(code)}
          </option>
        ))}
      </Field>
    </Row>
  );
}

export function Preferences({ notify, user }: { notify: Notify; user?: string }) {
  const [openOn, setOpenOn] = usePref("openOn");
  return (
    <div class={styles.page}>
      <p class={styles.note}>{t("prefs.note")}</p>

      <Group title="prefs.appearance">
        <Choose
          name="theme"
          title="prefs.theme"
          help="prefs.themeHelp"
          options={words(
            ["system", "prefs.system"],
            ["light", "prefs.light"],
            ["dark", "prefs.dark"],
          )}
        />
        <Choose
          name="density"
          title="prefs.density"
          help="prefs.densityHelp"
          options={words(["comfortable", "prefs.comfortable"], ["compact", "prefs.compact"])}
        />
        <Choose
          name="motion"
          title="prefs.motion"
          help="prefs.motionHelp"
          options={words(
            ["system", "prefs.system"],
            ["full", "prefs.full"],
            ["reduced", "prefs.reduced"],
          )}
        />
        <Language />
        <Row title={t("prefs.openOn")} help={t("prefs.openOnHelp")}>
          <Field
            as="select"
            label={t("prefs.openOn")}
            hideLabel
            class={styles.select}
            value={openOn}
            onChange={(e) => setOpenOn(e.currentTarget.value === "overview" ? "overview" : "last")}
          >
            <option value="last">{t("prefs.openLast")}</option>
            <option value="overview">{t("prefs.openOverview")}</option>
          </Field>
        </Row>
      </Group>

      <Group title="prefs.notifications">
        <Permission notify={notify} />
        <Toggle name="notifyReady" title="prefs.notifyReady" help={t("prefs.notifyReadyHelp")} />
        <Toggle name="notifyInput" title="prefs.notifyInput" help={t("prefs.notifyInputHelp")} />
        <Toggle name="notifyFailed" title="prefs.notifyFailed" help={t("prefs.notifyFailedHelp")} />
      </Group>

      <Group title="prefs.boardAndLog">
        <Choose
          name="phoneBoard"
          title="prefs.phoneBoard"
          help="prefs.phoneBoardHelp"
          options={words(["lanes", "prefs.lanes"], ["graph", "prefs.graph"])}
        />
        <Toggle name="showClosed" title="prefs.showClosed" help={t("prefs.showClosedHelp")} />
        <Toggle name="logFollow" title="prefs.logFollow" help={t("prefs.logFollowHelp")} />
        <Toggle name="logErrors" title="prefs.logErrors" help={t("prefs.logErrorsHelp")} />
        <Toggle name="logWrap" title="prefs.logWrap" help={t("prefs.logWrapHelp")} />
        <Toggle name="logTimes" title="prefs.logTimes" help={t("prefs.logTimesHelp")} />
      </Group>

      <Group title="prefs.keyboardAndAccount">
        <Toggle
          name="shortcuts"
          title="prefs.shortcuts"
          help={tx("prefs.shortcutsHelp", { key: <Kbd>/</Kbd> })}
        />
        {user && (
          <Row title={t("prefs.signedIn", { user })} help={t("prefs.signedInHelp")}>
            <form method="post" action="auth/logout">
              <Button type="submit">{t("prefs.signOut")}</Button>
            </form>
          </Row>
        )}
      </Group>
    </div>
  );
}
