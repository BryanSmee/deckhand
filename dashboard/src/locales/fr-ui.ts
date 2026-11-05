// French texts of the shared components in ui/ (not Gallery.tsx's demo texts): spread into the French catalog (fr.ts).
import type { Section } from ".";
import type { ui as en } from "./en-ui";

export const ui = {
  // Dialogs and sheets
  "ui.close": "Fermer",
  "ui.dialogSend": "{keys} pour envoyer",

  // Spinner, auto-pickup's mark, a rail's nav item
  "ui.loading": "Chargement",
  "ui.autoPickup": "Prise auto",
  "ui.navCounted": "{label} ({count})",

  // Meter: the run slots
  "ui.meter": {
    one: "{running} emplacement d’exécution utilisé sur {count}",
    other: "{running} emplacements d’exécution utilisés sur {count}",
  },
  "ui.meterAuto": {
    one: "{slots}, {auto} emplacement de prise auto utilisé sur {count}",
    other: "{slots}, {auto} emplacements de prise auto utilisés sur {count}",
  },

  // PlanUsage: each plan's limit windows
  "ui.planUsage": "Utilisation du forfait",
  "ui.planLimited": "limite atteinte",
  "ui.planWindowWeek": "semaine",
  "ui.planWindowWeekOpus": "semaine (Opus)",
  "ui.planWindowWeekSonnet": "semaine (Sonnet)",
  "ui.planPercent": "{n} %",
  "ui.planUsed": "{plan} {window} : {percent} utilisés",
  // The usage, then its notes (the ones below, joined as a list).
  "ui.planStale": "relevé avant sa dernière réinitialisation, donc plus à jour",
  "ui.planLimitedUntil": "limite atteinte jusqu’à {time}",
  "ui.planResets": "réinitialisation {time}",
  "ui.planAsOf": "relevé {ago}",
} satisfies Section<typeof en>;
