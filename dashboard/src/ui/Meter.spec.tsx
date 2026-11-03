// The run slots' meter: as before without auto-pickup; with it, its reserved slots at the end.
import { render, screen } from "@testing-library/preact";
import { expect, test } from "vitest";
import { Meter, type MeterAuto } from "./Meter";

// Each segment's look: "." empty, "s" a standard run, "-" reserved and free, "b" reserved and
// borrowed by a standard run, "a" an auto-picked run.
function segments(running: number, max: number, auto?: MeterAuto, rail?: boolean) {
  const { container } = render(<Meter running={running} max={max} auto={auto} rail={rail} />);
  return [...container.firstElementChild!.children]
    .map(({ className: c }) =>
      /auto/.test(c)
        ? "a"
        : /reserved/.test(c)
          ? /used/.test(c)
            ? "b"
            : "-"
          : /used/.test(c)
            ? "s"
            : ".",
    )
    .join("");
}

test("without auto-pickup: filled from the start, as many as run", () => {
  expect(segments(2, 4)).toBe("ss..");
  expect(screen.getAllByRole("img")[0].getAttribute("aria-label")).toBe("2 of 4 run slots in use");
});

test("the reserved slots are the last ones, dashed while free", () => {
  expect(segments(2, 6, { slots: 2, running: 0 })).toBe("ss..--");
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
    "2 of 6 run slots in use, 0 of 2 auto-pickup slots in use",
  );
});

test("auto-picked runs fill the reserved slots from the far end", () => {
  expect(segments(3, 6, { slots: 2, running: 1 })).toBe("ss..-a");
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
    "3 of 6 run slots in use, 1 of 2 auto-pickup slots in use",
  );
});

test("standard runs borrow free reserved slots: the filled ones are always as many as run", () => {
  expect(segments(4, 4, { slots: 1, running: 0 })).toBe("sssb");
  expect(segments(5, 6, { slots: 3, running: 1 })).toBe("sssb-a");
  expect(segments(4, 6, { slots: 3, running: 1 })).toBe("sss--a");
});

test("upright on the rail, the same order: the reserved slots at the far end", () => {
  expect(segments(2, 4, { slots: 1, running: 1 }, true)).toBe("s..a");
});

// Many slots: one bar, its parts' sizes in percent.
function bar(running: number, max: number, auto?: MeterAuto, rail?: boolean) {
  const { container } = render(<Meter running={running} max={max} auto={auto} rail={rail} />);
  const size = rail ? "height" : "width";
  return Object.fromEntries(
    [...container.firstElementChild!.children].map((el) => [
      /fill/i.test(el.className) && !/auto/i.test(el.className)
        ? "standard"
        : /zone/.test(el.className)
          ? "reserved"
          : "auto",
      (el as HTMLElement).style[size],
    ]),
  );
}

test("many slots: one bar, as before without auto-pickup", () => {
  expect(bar(5, 20)).toEqual({ standard: "25%" });
});

test("many slots with auto-pickup: the reserved zone at the end, the auto fill from its far edge", () => {
  expect(bar(6, 20, { slots: 4, running: 1 })).toEqual({
    standard: "25%",
    reserved: "20%",
    auto: "5%",
  });
  expect(bar(18, 20, { slots: 4, running: 0 }, true)).toEqual({
    standard: "90%",
    reserved: "20%",
  });
});
