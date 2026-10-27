// A field: its label names the control, help describes it, an error replaces the help and
// marks it invalid; a select has its chevron, a hint its key.
import { render, screen } from "@testing-library/preact";
import { expect, test } from "vitest";
import { Field } from "./Field";

test("the label names the input and the help describes it", () => {
  render(<Field label="Title" help="What should happen" placeholder="A title" />);
  const input = screen.getByLabelText("Title");
  expect(input.tagName).toBe("INPUT");
  expect(input.getAttribute("aria-invalid")).toBeNull();
  const note = document.getElementById(input.getAttribute("aria-describedby")!);
  expect(note?.textContent).toBe("What should happen");
});

test("an error replaces the help and marks it invalid", () => {
  render(<Field label="Title" help="What should happen" error="A title is needed" />);
  const input = screen.getByLabelText("Title");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const note = document.getElementById(input.getAttribute("aria-describedby")!);
  expect(note?.textContent).toBe("A title is needed");
  expect(screen.queryByText("What should happen")).toBeNull();
});

test("a select and a textarea, a hidden label still naming them", () => {
  render(
    <>
      <Field as="select" label="Repository" value="acme/api">
        <option>acme/app</option>
        <option>acme/api</option>
      </Field>
      <Field as="textarea" label="Details" rows={4} />
      <Field label="Search" hideLabel hint="/" />
    </>,
  );
  const select = screen.getByLabelText("Repository") as HTMLSelectElement;
  expect(select.tagName).toBe("SELECT");
  expect(select.value).toBe("acme/api");
  expect((screen.getByLabelText("Details") as HTMLTextAreaElement).rows).toBe(4);
  expect(screen.getByLabelText("Search").tagName).toBe("INPUT");
  expect(screen.getByText("/").tagName).toBe("KBD");
});
