// Tabs: the picked one selected and alone in the Tab order, arrows, Home and End move and
// pick, and the counts show.
import { fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { expect, test } from "vitest";
import { Tabs } from "./Tabs";

type Id = "backlog" | "waiting" | "answers";

function Queue() {
  const [tab, setTab] = useState<Id>("backlog");
  return (
    <Tabs
      label="Work queue"
      selected={tab}
      onSelect={setTab}
      tabs={[
        { id: "backlog", label: "Backlog", count: 12 },
        { id: "waiting", label: "Waiting", count: 3 },
        { id: "answers", label: "Answers", count: 1, hot: true },
      ]}
    />
  );
}

const selected = () => screen.getByRole("tab", { selected: true });

test("the picked tab is selected and the only one Tab reaches", () => {
  render(<Queue />);
  expect(screen.getByRole("tablist", { name: "Work queue" })).toBeTruthy();
  expect(selected().textContent).toBe("Backlog 12");
  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  fireEvent.click(screen.getByRole("tab", { name: /Waiting/ }));
  expect(selected().textContent).toBe("Waiting 3");
});

test("arrows, Home and End move between the tabs and pick them", () => {
  render(<Queue />);
  const list = screen.getByRole("tablist");
  fireEvent.keyDown(list, { key: "ArrowRight" });
  expect(selected().textContent).toMatch(/^Waiting/);
  expect(document.activeElement).toBe(selected());
  fireEvent.keyDown(list, { key: "End" });
  expect(selected().textContent).toMatch(/^Answers/);
  // Past the end, back to the start.
  fireEvent.keyDown(list, { key: "ArrowRight" });
  expect(selected().textContent).toMatch(/^Backlog/);
  fireEvent.keyDown(list, { key: "ArrowLeft" });
  expect(selected().textContent).toMatch(/^Answers/);
  fireEvent.keyDown(list, { key: "Home" });
  expect(selected().textContent).toMatch(/^Backlog/);
});
