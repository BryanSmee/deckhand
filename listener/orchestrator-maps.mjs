// The orchestrator's maps that hold data alone, in its store (orchestrator/server.mjs, one key
// per item: lib/store-map.mjs), with their options. Out of server.mjs, which can't grow (#1065).
import { ranked } from "./order.mjs";

export const MAPS = {
  titles: {},
  closed: {},
  pulls: {},
  marks: {},
  dismissed: {},
  order: { moved: ranked, replace: true },
  onboarding: {},
  lanes: {},
  modes: {},
  conflicts: {},
  // The workflows' instances, one per task and event (workflow-engine.mjs).
  workflows: {},
  "dry-runs": {},
  requested: {},
  waits: {},
  inputs: {},
  reviews: {},
  brainstorms: {},
  decisions: {},
  picks: {},
  machines: {},
  routes: {},
  admissions: {},
  stopped: {},
};
