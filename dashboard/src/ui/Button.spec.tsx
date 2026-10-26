// The button: pending shows at once and its spinner only after 400 ms, a pending button
// ignores clicks, a disabled one too, and the icon-only form names itself.
import { act, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Button, IconButton, SPINNER_DELAY } from "./Button";
import { Sync } from "./icons";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// The spinners shown: CSS Modules keep the class's name in the one they make.
const spinners = (button: HTMLElement) =>
  [...button.querySelectorAll("[class*=spinner]")].filter((el) => !el.closest("[class*=hidden]"));

test("pending says what it does at once, and spins only after 400 ms", () => {
  const { rerender } = render(<Button pendingLabel="Starting…">Start</Button>);
  const button = screen.getByRole("button", { name: "Start" });
  expect(button.getAttribute("aria-busy")).toBeNull();
  rerender(
    <Button pending pendingLabel="Starting…">
      Start
    </Button>,
  );
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.textContent).toContain("Starting…");
  expect(spinners(button)).toHaveLength(0);
  act(() => void vi.advanceTimersByTime(SPINNER_DELAY - 1));
  expect(spinners(button)).toHaveLength(0);
  act(() => void vi.advanceTimersByTime(1));
  expect(spinners(button)).toHaveLength(1);
  // Done: no spinner left behind.
  rerender(<Button pendingLabel="Starting…">Start</Button>);
  expect(button.getAttribute("aria-busy")).toBeNull();
  expect(spinners(button)).toHaveLength(0);
});

test("a pending button stays focusable but ignores clicks", () => {
  const onClick = vi.fn();
  render(
    <Button pending onClick={onClick}>
      Send
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Send" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
});

test("a disabled button doesn't click; an enabled one does", () => {
  const onClick = vi.fn();
  const { rerender } = render(
    <Button disabled onClick={onClick}>
      Start
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  button.click();
  expect(onClick).not.toHaveBeenCalled();
  rerender(<Button onClick={onClick}>Start</Button>);
  button.click();
  expect(onClick).toHaveBeenCalledTimes(1);
  // A button, not a submit, unless asked.
  expect(button.type).toBe("button");
});

test("an icon-only button is named by its label", () => {
  render(<IconButton label="Sync with GitHub" icon={<Sync />} />);
  const button = screen.getByRole("button", { name: "Sync with GitHub" });
  expect(button.title).toBe("Sync with GitHub");
});
