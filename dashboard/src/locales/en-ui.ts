// English texts of The shared components in ui/ (not Gallery.tsx's demo texts): spread into the catalog (en.ts).
export const ui = {
  // Dialogs and sheets
  "ui.close": "Close",
  "ui.dialogSend": "{keys} to send",

  // Spinner, auto-pickup's mark, a rail's nav item
  "ui.loading": "Loading",
  "ui.autoPickup": "Auto-pickup",
  "ui.navCounted": "{label} ({count})",

  // Meter: the run slots
  "ui.meter": {
    one: "{running} of {count} run slot in use",
    other: "{running} of {count} run slots in use",
  },
  "ui.meterAuto": {
    one: "{slots}, {auto} of {count} auto-pickup slot in use",
    other: "{slots}, {auto} of {count} auto-pickup slots in use",
  },

  // PlanUsage: each plan's limit windows
  "ui.planUsage": "Plan usage",
  "ui.planLimited": "limit reached",
  "ui.planWindowWeek": "week",
  "ui.planWindowWeekOpus": "week (Opus)",
  "ui.planWindowWeekSonnet": "week (Sonnet)",
  "ui.planPercent": "{n} %",
  "ui.planUsed": "{plan} {window}: {percent} used",
  // The usage, then its notes (the ones below, joined as a list).
  "ui.planStale": "read before its last reset, so no longer current",
  "ui.planLimitedUntil": "limit reached until {time}",
  "ui.planResets": "resets {time}",
  "ui.planAsOf": "as of {ago}",
} as const;
