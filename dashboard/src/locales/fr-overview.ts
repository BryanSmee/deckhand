// French texts of Overview and its tiles (Overview.tsx, overview.ts): spread into the French
// catalog (fr.ts).
import type { Section } from ".";
import type { overview as en } from "./en-overview";

export const overview = {
  // Totals: a tile's label, then what is in it.
  "overview.tile": "{label} : {count}, {meta}",
  "overview.running": "En cours",
  "overview.ofSlots": { one: "sur {count} emplacement", other: "sur {count} emplacements" },
  "overview.autoPicked": "{count} en prise auto",
  "overview.queued": "{count} en file",
  "overview.needsYou": "Vous attend",
  "overview.questions": { one: "{count} question", other: "{count} questions" },
  "overview.brainstormTurns": {
    one: "{count} tour de brainstorm",
    other: "{count} tours de brainstorm",
  },
  "overview.idleBrainstorms": {
    one: "{count} brainstorm inactif",
    other: "{count} brainstorms inactifs",
  },
  "overview.nothingAsks": "rien ne vous attend",
  "overview.readyForReview": "Prêtes pour la revue",
  "overview.nothingToReview": "rien à relire",
  // {list}: "#141 and #132".
  "overview.pullRequestList": { one: "pull request {list}", other: "pull requests {list}" },
  "overview.pullRequests": { one: "{count} pull request", other: "{count} pull requests" },
  "overview.notClean": "{count} avec blocage",
  "overview.failed": "Échouées",
  "overview.nothingFailed": "aucun échec",
  "overview.canBeRerun": "relance possible",
  "overview.someCanBeRerun": {
    one: "{count} peut être relancée",
    other: "{count} peuvent être relancées",
  },

  // Waiting on you: its rows' badges and actions.
  "overview.waitingOnYou": "En attente de vous",
  "overview.oldestFirst": "Plus anciennes d’abord",
  "overview.nothingWaits": "Rien ne vous attend.",
  "overview.needsInput": "Réponse attendue",
  "overview.yourTurn": "Votre tour",
  "overview.answer": "Répondre",
  "overview.reply": "Répondre",
  "overview.reviewPr": "Relire la PR",
  "overview.rerun": "Relancer",
  "overview.rerunning": "Relance…",
  "overview.rerunHelp": "La relance avec les mêmes commentaires et le même mode",
  "overview.rerunQueued": "Relance de {task} ({repo}) en file.",
  "overview.dismiss": "Écarter",
  "overview.dismissing": "Mise à l’écart…",
  "overview.dismissHelp":
    "Elle ne vous attend plus jusqu’à la prochaine exécution ; sa page de tâche peut l’annuler",
  "overview.dismissed": "{task} ({repo}) écartée : sa page de tâche peut l’annuler.",
  "overview.open": "Ouvrir",
  "overview.answerTitle": "Répondre à {task}",

  // A row's age: how long it has waited.
  "overview.ageNow": "maintenant",
  "overview.ageMinutes": "{n} min",
  "overview.ageHours": "{n} h",
  "overview.ageDays": "{n} j",

  // Repositories: a card each.
  "overview.repositories": "Dépôts",
  "overview.cantList": "Impossible de lister les dépôts ({error})",
  "overview.loading": "Chargement…",
  "overview.noRepository": "Aucun dépôt pour l’instant.",
  "overview.nothingGoingOn": "Rien en cours.",
  "overview.noTasks": "Aucune tâche",
  "overview.openBoard": "Ouvrir le tableau",
  "overview.onboardHelp":
    "L’onboarding ouvre une exécution qui propose son .deckhand.yaml dans une pull request.",
  "overview.issuesOff":
    "Ses issues sont désactivées sur GitHub : activez-les pour lancer son onboarding.",
  "overview.noConfig": "Pas encore de config",
  "overview.onboard": "Onboarder",
  "overview.onboarding": "Onboarding…",
  "overview.onboardingOn": "Son onboarding tourne sur l’issue #{number}.",
  "overview.beingOnboarded": "Onboarding en cours",
  "overview.openIssue": "Ouvrir l’issue",
  "overview.configErrors":
    "Son .deckhand.yaml contient des erreurs : aucune exécution ne démarre tant qu’elles ne sont pas corrigées.",
  "overview.seeConfig": "Voir la config",

  // A card's tasks by state ("2 running · 2 need you"), and its backlog and lanes.
  "overview.partRunning": "{count} en cours",
  "overview.partInput": { one: "{count} vous attend", other: "{count} vous attendent" },
  "overview.partReady": "{count} à relire",
  "overview.partFailed": "{count} en échec",
  "overview.partQueued": "{count} en file",
  "overview.partIdle": "{count} au repos",
  "overview.partEnded": {
    one: "{count} terminée cette semaine",
    other: "{count} terminées cette semaine",
  },
  "overview.partMerged": {
    one: "{count} fusionnée cette semaine",
    other: "{count} fusionnées cette semaine",
  },
  "overview.backlog": "Backlog {count}",
  // More than the count read: "Backlog 100+".
  "overview.backlogMore": "Backlog {count}+",
  "overview.lanes": { one: "{count} colonne", other: "{count} colonnes" },
} satisfies Section<typeof en>;
