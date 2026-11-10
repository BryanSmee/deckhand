// The parts of a run, each its own section of its log (listener/runlog.mjs PHASES). A phase
// may come back: setup after the image's build, work after a push. Logs from before phases
// have none: all of them is work.
export type Phase = "setup" | "image" | "work" | "push" | "wrap-up";

// How a step of an image's build is (`docker build --progress plain`): the latest `step`
// entry of a number says it.
export type StepStatus = "running" | "cached" | "done" | "error" | "cancelled";

// What the log stream sends, in order. Failures: an `output` with `error`, a `step` with
// status "error" (its `error` says why): logModel.ts counts them per section.
// `at` on any of them: when it came (ms, listener/runlog.mjs reader()), what the log's
// timestamps show; none in logs from before them (#719 for messages, notes and setup output).
export type Entry =
  | { kind: "text"; text: string; at?: number }
  // A chat owner's message (listener/runlog.mjs): the one that started the run, or one delivered
  // to it since.
  | { kind: "message"; text: string; at?: number }
  | { kind: "meta"; text: string; at?: number }
  // Setup output; with `step`, the output of that image build step, without BuildKit's prefix.
  // Its `at`: the last time said in its run of plain lines (listener/runlog.mjs reader()).
  | { kind: "raw"; text: string; step?: number; at?: number }
  // `id`: what pairs a call with its outputs, when the agent gives one (a call with one has an
  // output to come); `done`: it came whole, with no output to wait for (Codex's edits);
  // `at`: when it came (ms, listener/runlog.mjs reader()). None in logs from before them.
  | { kind: "tool"; name: string; text: string; id?: string; done?: boolean; at?: number }
  | { kind: "output"; text: string; error: boolean; id?: string; at?: number }
  | {
      kind: "result";
      status: "ok" | "needs-input" | "error";
      text: string;
      minutes: number;
      at?: number;
    }
  // The entries after it, up to the next one, are this phase's; `at`: when it started (ms).
  | { kind: "phase"; phase: Phase; at: number }
  // An image build step as it starts, then as its status changes. `stage`: "build 5/9" in
  // "[build 5/9] RUN npm ci", "internal" for BuildKit's own steps, null for those it doesn't
  // name ("exporting to image"); `seconds` once done.
  | {
      kind: "step";
      step: number;
      stage: string | null;
      name: string;
      status: StepStatus;
      seconds: number | null;
      error: string | null;
      // When it started (ms), in logs since steps were timed.
      at?: number;
    };
