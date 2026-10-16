// One tab per repo, plus All. Each counts its tasks that are running and those waiting for
// the maintainer.
import { useEffect, useRef } from "preact/hooks";
import { inChip, repoTabs, shortRepo } from "./format";
import type { Task } from "./types";
import styles from "./Tabs.module.css";

interface Props {
  tasks: Task[];
  repo: string | null;
  onSelect: (repo: string | null) => void;
}

export function Tabs({ tasks, repo, onSelect }: Props) {
  const tabs = repoTabs(tasks);
  // A repo from the address that has no task (yet) still gets its tab.
  if (repo && !tabs.some((t) => t.repo === repo)) {
    tabs.push({ repo, label: shortRepo(repo) });
  }
  const all = [{ repo: null, label: "All" }, ...tabs];
  // The open tab stays in view on a narrow screen, where they scroll sideways.
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    nav.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [repo, all.map((t) => t.repo).join(" ")]);
  return (
    <nav class={styles.tabs} role="tablist" aria-label="Repositories" ref={nav}>
      {all.map((tab) => {
        const mine = tab.repo ? tasks.filter((t) => t.repo === tab.repo) : tasks;
        const live = mine.filter((t) => inChip("running", t)).length;
        const input = mine.filter((t) => inChip("input", t)).length;
        return (
          <button
            key={tab.repo ?? ""}
            type="button"
            role="tab"
            class={styles.tab}
            aria-selected={tab.repo === repo}
            title={tab.repo ?? "Every repo"}
            onClick={() => onSelect(tab.repo)}
          >
            {tab.label}
            {live > 0 && (
              <span class={`${styles.count} ${styles.live}`} title={`${live} running`}>
                {live}
              </span>
            )}
            {input > 0 && (
              <span class={`${styles.count} ${styles.input}`} title={`${input} waiting for you`}>
                {input}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
