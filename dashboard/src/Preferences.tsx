// Settings › Preferences (docs/design/dashboard-redesign.md › Pages › Settings › Preferences): the
// choices kept in this browser (prefs.ts), in four groups. Each changes the page at once, here and
// wherever it applies; the browser's notification permission is the browser's, asked from here too.
import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import type { Notify } from "./notify";
import { type PrefName, type Prefs, usePref } from "./prefs";
import { Button } from "./ui/Button";
import { type Segment, Segmented, Switch } from "./ui/Choice";
import { Field } from "./ui/Field";
import { Kbd } from "./ui/Kbd";
import styles from "./Preferences.module.css";

const words = <T extends string>(...pairs: [T, string][]): Segment<T>[] =>
  pairs.map(([value, label]) => ({ value, label }));

const THEMES = words(["system", "System"], ["light", "Light"], ["dark", "Dark"]);
const DENSITIES = words(["comfortable", "Comfortable"], ["compact", "Compact"]);
const MOTIONS = words(["system", "System"], ["full", "Full"], ["reduced", "Reduced"]);
const BOARDS = words(["lanes", "Lanes"], ["graph", "Graph"]);

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
  title: string;
  help: string;
  options: Segment<Prefs[K]>[];
}) {
  const [value, set] = usePref(name);
  return (
    <Row title={title} help={help}>
      <Segmented label={title} options={options} value={value} onChange={set} />
    </Row>
  );
}

type Flag = { [K in PrefName]: Prefs[K] extends boolean ? K : never }[PrefName];

// The whole row is the switch's label; the help describes it.
function Toggle({ name, title, help }: { name: Flag; title: string; help: ComponentChildren }) {
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
          <b id={`${id}-title`}>{title}</b>
          <span id={`${id}-help`}>{help}</span>
        </span>
      }
    />
  );
}

function Group({ title, children }: { title: string; children: ComponentChildren }) {
  const id = useId();
  return (
    <section class={styles.group} aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

const PERMISSIONS: Record<Notify["permission"], { text: string; tone?: string }> = {
  granted: { text: "Allowed in this browser.", tone: styles.allowed },
  default: { text: "Not allowed yet: this browser asks first." },
  denied: { text: "Blocked in this browser's site settings.", tone: styles.blocked },
  unsupported: { text: "This browser doesn't show them." },
};

function Permission({ notify }: { notify: Notify }) {
  const { text, tone } = PERMISSIONS[notify.permission];
  return (
    <Row
      title="Browser notifications"
      help={
        <>
          While a Deckhand tab is open. <span class={tone}>{text}</span>
        </>
      }
    >
      {notify.permission === "default" ? (
        <Button onClick={() => void notify.ask()}>Allow notifications</Button>
      ) : (
        <Button disabled={notify.permission !== "granted"} onClick={notify.test}>
          Send a test
        </Button>
      )}
    </Row>
  );
}

export function Preferences({ notify, user }: { notify: Notify; user?: string }) {
  const [openOn, setOpenOn] = usePref("openOn");
  return (
    <div class={styles.page}>
      <p class={styles.note}>
        Kept in this browser, not on the server: another device has its own.
      </p>

      <Group title="Appearance">
        <Choose
          name="theme"
          title="Theme"
          help="System follows your device's light or dark setting."
          options={THEMES}
        />
        <Choose
          name="density"
          title="Density"
          help="Compact fits more tasks and log lines on a screen."
          options={DENSITIES}
        />
        <Choose
          name="motion"
          title="Motion"
          help="Pulsing dots, sliding panels. Reduced keeps fades only."
          options={MOTIONS}
        />
        <Row title="Open on" help="What the dashboard shows when you come back.">
          <Field
            as="select"
            label="Open on"
            hideLabel
            class={styles.select}
            value={openOn}
            onChange={(e) => setOpenOn(e.currentTarget.value === "overview" ? "overview" : "last")}
          >
            <option value="last">The repository open last</option>
            <option value="overview">Overview</option>
          </Field>
        </Row>
      </Group>

      <Group title="Notifications">
        <Permission notify={notify} />
        <Toggle
          name="notifyReady"
          title="A pull request is ready for review"
          help="The notification opens its task."
        />
        <Toggle
          name="notifyInput"
          title="A run needs your answers"
          help="Open questions, or a brainstorm waiting for your turn. The notification opens its task."
        />
        <Toggle
          name="notifyFailed"
          title="A run failed"
          help="Errors and interrupted runs. The notification opens its task."
        />
      </Group>

      <Group title="Board and run log">
        <Choose
          name="phoneBoard"
          title="Board on a phone"
          help="The graph is hard to read on a small screen."
          options={BOARDS}
        />
        <Toggle
          name="showClosed"
          title="Show closed issues on the board"
          help="Implemented and not planned ones, and merged pull requests."
        />
        <Toggle
          name="logFollow"
          title="Follow a running log live"
          help="Scrolls with new lines until you scroll up."
        />
        <Toggle
          name="logErrors"
          title="Open the sections with errors"
          help="A failed command or build step opens by itself."
        />
        <Toggle
          name="logWrap"
          title="Wrap long log lines"
          help="Off: long lines scroll sideways."
        />
      </Group>

      <Group title="Keyboard and account">
        <Toggle
          name="shortcuts"
          title="Keyboard shortcuts"
          help={
            <>
              Single keys, like <Kbd>/</Kbd> to search the tasks. They never fire while you type.
            </>
          }
        />
        {user && (
          <Row
            title={`Signed in as @${user}`}
            help="Through GitHub. The operator's ALLOWED_USERS lets you in. Signing out ends your sessions on every device, and your MCP clients'."
          >
            <form method="post" action="auth/logout">
              <Button type="submit">Sign out</Button>
            </form>
          </Row>
        )}
      </Group>
    </div>
  );
}
