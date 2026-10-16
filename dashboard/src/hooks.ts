// The hooks the views share: a ticking clock, a form's send, a drop zone, a dialog's ways out.
// Reading the listener's API is api.ts's (usePolled()).
import { useEffect, useState } from "preact/hooks";

// The clock "read … ago" is compared with, ticking.
export function useNow(everyMs = 15000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

export interface Submit<A extends unknown[], R> {
  // On its way: the form is disabled, its button says so.
  sending: boolean;
  // What the listener refused it with, until the next send.
  error: string | null;
  // Sends it: what the listener said.
  run: (...args: A) => Promise<R>;
}

// A form's send: `fn` posts it and says what the listener answered.
export function useSubmit<A extends unknown[], R extends { error?: string }>(
  fn: (...args: A) => Promise<R>,
): Submit<A, R> {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (...args: A) => {
    setSending(true);
    setError(null);
    const result = await fn(...args);
    setSending(false);
    if (result.error) setError(result.error);
    return result;
  };
  return { sending, error, run };
}

export interface DropZone {
  // Something it takes is dragged over it.
  over: boolean;
  handlers: {
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
}

// An element things are dropped on: those `accepts` takes (by their types, as a drag over
// can't read the data) and, let go, `onDrop`. `onOver`: each move over it, then null once it
// leaves or is let go.
export function useDropZone(
  accepts: (e: DragEvent) => boolean,
  onDrop: (e: DragEvent) => void,
  {
    effect = "copy",
    onOver,
  }: { effect?: DataTransfer["dropEffect"]; onOver?: (e: DragEvent | null) => void } = {},
): DropZone {
  const [over, setOver] = useState(false);
  const leave = () => {
    setOver(false);
    onOver?.(null);
  };
  return {
    over,
    handlers: {
      onDragOver: (e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = effect;
        setOver(true);
        onOver?.(e);
      },
      // Into one of its children isn't out of it.
      onDragLeave: (e) => {
        if ((e.currentTarget as Node).contains(e.relatedTarget as Node | null)) return;
        leave();
      },
      onDrop: (e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        leave();
        onDrop(e);
      },
    },
  };
}

// The types a drag carries.
export const typesOf = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])];

// A dialog's ways out besides its own buttons, while it is shown: Escape, and a link that
// opens another view.
export function useDismiss(onClose: () => void) {
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", close);
    addEventListener("hashchange", onClose);
    return () => {
      removeEventListener("keydown", close);
      removeEventListener("hashchange", onClose);
    };
  }, []);
}
