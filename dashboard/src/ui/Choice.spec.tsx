// The choices: a segmented control's pressed button or current link, the switch's role and
// state, a checkbox and option cards, each by keyboard as by click.
import { fireEvent, render, screen } from "@testing-library/preact";
import { expect, test, vi } from "vitest";
import { Checkbox, OptionCard, Segmented, Switch } from "./Choice";

const VIEWS = [
  { value: "graph", label: "Graph" },
  { value: "lanes", label: "Lanes" },
] as const;

test("a segmented control presses the value's button and picks another", () => {
  const onChange = vi.fn();
  render(<Segmented label="Board view" options={VIEWS} value="graph" onChange={onChange} />);
  expect(screen.getByRole("group", { name: "Board view" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Graph" }).getAttribute("aria-pressed")).toBe("true");
  const lanes = screen.getByRole("button", { name: "Lanes" });
  expect(lanes.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(lanes);
  expect(onChange).toHaveBeenCalledWith("lanes");
});

test("as views, it is links, the current one marked", () => {
  render(
    <Segmented
      label="Pages"
      value="board"
      options={[
        { value: "tasks", label: "Tasks", href: "#/acme/app" },
        { value: "board", label: "Board", href: "#/acme/app/board" },
      ]}
    />,
  );
  const board = screen.getByRole("link", { name: "Board" });
  expect(board.getAttribute("aria-current")).toBe("page");
  expect(board.getAttribute("href")).toBe("#/acme/app/board");
  expect(screen.getByRole("link", { name: "Tasks" }).getAttribute("aria-current")).toBeNull();
});

test("an icon-only segment is named by its label", () => {
  render(
    <Segmented
      label="Theme"
      value="dark"
      options={[{ value: "dark", label: "Dark theme", icon: <svg />, iconOnly: true }]}
    />,
  );
  const dark = screen.getByRole("button", { name: "Dark theme" });
  expect(dark.textContent).toBe("");
});

test("a switch is a switch, and says when it turns", () => {
  const onChange = vi.fn();
  render(<Switch label="Show closed" checked={false} onChange={onChange} />);
  const toggle = screen.getByRole("switch", { name: "Show closed" }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith(true);
});

test("a checkbox says when it turns; disabled, it doesn't", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <Checkbox label="Open questions first" checked onChange={onChange} />,
  );
  const box = screen.getByRole("checkbox", { name: "Open questions first" }) as HTMLInputElement;
  fireEvent.click(box);
  expect(onChange).toHaveBeenCalledWith(false);
  rerender(<Checkbox label="Open questions first" checked disabled onChange={onChange} />);
  expect(box.disabled).toBe(true);
});

test("option cards are radios of one group", () => {
  const onChange = vi.fn();
  render(
    <>
      <OptionCard name="q1" value="yes" label="Yes" help="Every run counts" checked />
      <OptionCard name="q1" value="no" label="No" onChange={onChange} />
    </>,
  );
  const yes = screen.getByRole("radio", { name: /Yes/ }) as HTMLInputElement;
  const no = screen.getByRole("radio", { name: "No" }) as HTMLInputElement;
  expect(yes.checked).toBe(true);
  fireEvent.click(no);
  expect(onChange).toHaveBeenCalled();
});
