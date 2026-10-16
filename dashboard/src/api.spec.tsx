// usePolled() against a fake listener whose answers come when the test says: a slow answer
// older than one shown is dropped, a change to the one shown doesn't drop the first read, and
// an error keeps the last answer.
import { act, render, waitFor } from "@testing-library/preact";
import { expect, test, vi } from "vitest";
import { type Polled, usePolled } from "./api";

// Each fetch waits until the test answers it, in any order.
function slowListener() {
  const waiting: ((res: Response) => void)[] = [];
  vi.stubGlobal(
    "fetch",
    () => new Promise<Response>((resolve) => waiting.push((res) => resolve(res))),
  );
  return waiting;
}

function poll(url: string) {
  const seen: { current: Polled<{ n: number }> | null } = { current: null };
  function Probe() {
    seen.current = usePolled<{ n: number }>(url, null);
    return null;
  }
  render(<Probe />);
  return seen;
}

test("a slow read older than one shown is dropped", async () => {
  const waiting = slowListener();
  const seen = poll("api/thing");
  await waitFor(() => expect(waiting).toHaveLength(1));
  act(() => void seen.current!.reload());
  await waitFor(() => expect(waiting).toHaveLength(2));
  await act(async () => waiting[1](Response.json({ n: 2 })));
  await waitFor(() => expect(seen.current!.data).toEqual({ n: 2 }));
  await act(async () => waiting[0](Response.json({ n: 1 })));
  await new Promise((r) => setTimeout(r, 10));
  expect(seen.current!.data).toEqual({ n: 2 });
});

test("a change to what is shown doesn't drop the first read on its way", async () => {
  const waiting = slowListener();
  const seen = poll("api/thing");
  await waitFor(() => expect(waiting).toHaveLength(1));
  act(() => seen.current!.show((last) => last && { n: last.n + 1 }));
  await act(async () => waiting[0](Response.json({ n: 1 })));
  await waitFor(() => expect(seen.current!.data).toEqual({ n: 1 }));
  act(() => seen.current!.show((last) => last && { n: last.n + 1 }));
  expect(seen.current!.data).toEqual({ n: 2 });
});

test("an error keeps the last answer, and says why", async () => {
  const waiting = slowListener();
  const seen = poll("api/thing");
  await waitFor(() => expect(waiting).toHaveLength(1));
  await act(async () => waiting[0](Response.json({ n: 1 })));
  act(() => void seen.current!.reload());
  await waitFor(() => expect(waiting).toHaveLength(2));
  await act(async () => waiting[1](new Response("", { status: 502 })));
  await waitFor(() => expect(seen.current!.error).toBe("502"));
  expect(seen.current!.data).toEqual({ n: 1 });
});
