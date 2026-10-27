// The dialog: focus moves in and stays in (Tab and Shift Tab wrap), Escape and the scrim
// close it, Ctrl Enter sends it, and focus goes back where it was once it closes.
import { fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { expect, test, vi } from "vitest";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Field } from "./Field";

function Page({ onSubmit = () => {} }: { onSubmit?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>New request</Button>
      {open && (
        <Dialog
          title="New request"
          sub="Files an issue"
          onClose={() => setOpen(false)}
          onSubmit={onSubmit}
          actions={<Button variant="primary">Send idea</Button>}
        >
          <Field label="Title" />
        </Dialog>
      )}
    </>
  );
}

const open = () => {
  const opener = screen.getByRole("button", { name: "New request" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
};
const tab = (shiftKey = false) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab", shiftKey });

test("it is a named modal dialog, its first field focused", () => {
  render(<Page />);
  open();
  const dialog = screen.getByRole("dialog", { name: "New request" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText("Title"));
});

test("Tab and Shift Tab wrap inside it", () => {
  render(<Page />);
  open();
  const close = screen.getByRole("button", { name: "Close" });
  const title = screen.getByLabelText("Title");
  const send = screen.getByRole("button", { name: "Send idea" });
  // From the last one to the first: the close button, in the head.
  send.focus();
  tab();
  expect(document.activeElement).toBe(close);
  // And back.
  tab(true);
  expect(document.activeElement).toBe(send);
  // In between, the browser moves it: nothing stopped.
  title.focus();
  expect(tab()).toBe(true);
});

test("Escape closes it and focus goes back to what opened it", () => {
  render(<Page />);
  const opener = open();
  fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test("a click on the scrim closes it, one inside doesn't", () => {
  render(<Page />);
  open();
  const dialog = screen.getByRole("dialog");
  fireEvent.pointerDown(dialog);
  fireEvent.click(dialog);
  expect(screen.queryByRole("dialog")).not.toBeNull();
  fireEvent.pointerDown(dialog.parentElement!);
  fireEvent.click(dialog.parentElement!);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a drag from a field that ends on the scrim keeps it open", () => {
  render(<Page />);
  open();
  const title = screen.getByLabelText("Title") as HTMLInputElement;
  fireEvent.input(title, { target: { value: "Show each run's duration" } });
  // Selecting the text, released past the dialog's edge: the click lands on the scrim.
  fireEvent.pointerDown(title);
  fireEvent.click(screen.getByRole("dialog").parentElement!);
  expect(screen.queryByRole("dialog")).not.toBeNull();
  expect(title.value).toBe("Show each run's duration");
});

test("Ctrl Enter or ⌘ Enter sends it; Enter alone doesn't", () => {
  const onSubmit = vi.fn();
  render(<Page onSubmit={onSubmit} />);
  open();
  const title = screen.getByLabelText("Title");
  fireEvent.keyDown(title, { key: "Enter" });
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(title, { key: "Enter", metaKey: true });
  expect(onSubmit).toHaveBeenCalledTimes(2);
  // The footer says so.
  expect(screen.getByRole("dialog").textContent).toMatch(/↵ to send/);
});
