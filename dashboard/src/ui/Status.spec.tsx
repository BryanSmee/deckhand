// Status: a state's tone and word, running the only thing that pulses, a brainstorm's turn
// outlined, and a dot alone naming itself. With them, the small parts that only show: chips,
// counts, nav items, notices and folds.
import { fireEvent, render, screen } from "@testing-library/preact";
import { expect, test, vi } from "vitest";
import { FilterChip } from "./FilterChip";
import { Fold } from "./Fold";
import { NavItem } from "./NavItem";
import { StatusBadge, StatusDot } from "./Status";
import { Notice } from "./Surface";

test("a badge has its state's word and tone", () => {
  render(
    <>
      <StatusBadge state="needs-input" />
      <StatusBadge state="scheduled" />
      <StatusBadge state="cancelled" />
      <StatusBadge state="ok" />
      <StatusBadge tone="ready" label="Ready for review" />
    </>,
  );
  expect(screen.getByText("Needs input").className).toContain("s-input");
  expect(screen.getByText("Scheduled").className).toContain("s-run");
  expect(screen.getByText("Stopped").className).toContain("s-idle");
  // Done is grey: green is for a merged pull request alone (format.ts taskStatus()).
  expect(screen.getByText("Done").className).toContain("s-idle");
  expect(screen.getByText("Ready for review").className).toContain("s-ready");
});

test("only a run going on pulses; a brainstorm's turn is outlined", () => {
  render(
    <>
      <StatusBadge state="working" />
      <StatusBadge state="scheduled" />
      <StatusBadge state="building-image" />
      <StatusBadge state="brainstorm" />
      <StatusBadge state="needs-input" />
    </>,
  );
  const dot = (word: string) => screen.getByText(word).querySelector("span")!;
  expect(dot("Working").className).toContain("pulse");
  expect(dot("Building image").className).not.toContain("pulse");
  // Its agent hasn't started yet: nothing moves.
  expect(dot("Scheduled").className).not.toContain("pulse");
  expect(screen.getByText("Brainstorm").className).toContain("outline");
  expect(screen.getByText("Needs input").className).not.toContain("outline");
});

test("a dot next to its word is hidden; alone, it names itself", () => {
  render(
    <>
      <StatusDot state="error" />
      <StatusDot tone="done" label="Done" />
    </>,
  );
  expect(screen.getByRole("img", { name: "Done" })).toBeTruthy();
  expect(screen.getAllByRole("img")).toHaveLength(1);
});

test("a filter chip is a toggle with its count", () => {
  const onClick = vi.fn();
  render(
    <FilterChip pressed={false} count={3} onClick={onClick}>
      Running
    </FilterChip>,
  );
  const chip = screen.getByRole("button", { name: "Running 3" });
  expect(chip.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(chip);
  expect(onClick).toHaveBeenCalled();
});

test("a nav item marks the current page; on the rail its label names it, its count a dot", () => {
  render(
    <>
      <NavItem href="#/" label="Overview" current />
      <NavItem href="#/settings" label="Settings" rail count={2} hot />
    </>,
  );
  expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  const settings = screen.getByRole("link", { name: "Settings (2)" });
  expect(settings.getAttribute("aria-current")).toBeNull();
  expect(settings.title).toBe("Settings");
  // A number would cover a short repository name on the 40 px rail.
  expect(settings.textContent).toBe("");
});

test("an error notice is an alert, the others a status", () => {
  render(
    <>
      <Notice tone="err">Config has errors</Notice>
      <Notice tone="done">Queued #24</Notice>
    </>,
  );
  expect(screen.getByRole("alert").textContent).toBe("Config has errors");
  expect(screen.getByRole("status").textContent).toBe("Queued #24");
});

test("a fold opens and says so", () => {
  const onToggle = vi.fn();
  render(
    <Fold title="Setup" tone="done" meta="6s" onToggle={onToggle}>
      Cloned
    </Fold>,
  );
  const details = screen.getByText("Setup").closest("details")!;
  expect(details.open).toBe(false);
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(onToggle).toHaveBeenCalledWith(true);
});
