// The Repositories toolbar's Manage App: a small menu of links to the App on GitHub, where
// repositories are added or removed and its permissions, events and webhook are set. GitHub
// decides who may change anything: someone who doesn't own the App sees its 404 there.
// Escape, a click beside it or a link that opens another view closes it.
import { useEffect, useRef, useState } from "preact/hooks";
import { useDismiss } from "./hooks";
import type { AppLinks } from "./types";
import styles from "./Repos.module.css";

// Adding or removing repositories: with a single installation, that installation's page;
// else GitHub's install page, which lists every account with Configure where it is installed.
export function reposUrl(app: AppLinks): string {
  return app.installations.length === 1 ? app.installations[0].url : app.installUrl;
}

export function ManageApp({ app }: { app: AppLinks }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={styles.manage}>
      <button
        type="button"
        class={styles.refresh}
        aria-expanded={open}
        aria-controls="manage-app"
        title={`${app.name} on GitHub: its repositories and settings`}
        onClick={() => setOpen(!open)}
      >
        Manage App ▾
      </button>
      {open && <Menu app={app} onClose={() => setOpen(false)} />}
    </div>
  );
}

function Menu({ app, onClose }: { app: AppLinks; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useDismiss(onClose);
  useEffect(() => {
    // Beside it, its button included: that one's own click would open it again.
    const beside = (e: PointerEvent) => {
      const box = menu.current?.parentElement;
      if (box && !box.contains(e.target as Node)) onClose();
    };
    addEventListener("pointerdown", beside);
    return () => removeEventListener("pointerdown", beside);
  }, []);
  const single = app.installations.length === 1 ? app.installations[0].account : null;
  return (
    <div ref={menu} id="manage-app" class={styles.menu}>
      <a href={reposUrl(app)} target="_blank" rel="noreferrer" onClick={onClose}>
        Add or remove repositories
        <span>
          {single ? `The installation on ${single}` : "Install it on an account, or configure one"}
        </span>
      </a>
      <a href={app.settingsUrl} target="_blank" rel="noreferrer" onClick={onClose}>
        App settings
        <span>Permissions, events, webhook</span>
      </a>
    </div>
  );
}
