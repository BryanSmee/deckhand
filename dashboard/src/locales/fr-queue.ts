// French texts of the board's work queue (WorkQueue.tsx): spread into the French catalog (fr.ts).
import type { Section } from ".";
import type { queue as en } from "./en-queue";

export const queue = {
  // WorkQueue.tsx: the board's work queue, its tabs and what each says when empty.
  "queue.label": "File de travail",
  "queue.collapse": "Replier la file de travail",
  "queue.expand": "Déplier la file de travail",
  "queue.backlog": "Backlog",
  "queue.brainstorm": "Brainstorm",
  "queue.waiting": "En attente",
  "queue.answers": "Réponses",
  "queue.queued": "En file",
  "queue.backlogList": "Issues ouvertes sans tâche",
  "queue.backlogNoMatch": "Aucune issue ouverte ne correspond.",
  "queue.backlogEmpty": "Plus aucune issue ouverte à lancer.",
  "queue.brainstormList": "Issues en brainstorm",
  "queue.brainstormEmpty": "Aucun brainstorm en cours.",
  "queue.waitingList": "Issues en attente",
  "queue.waitingEmpty": "Aucune issue n’en attend une autre.",
  "queue.answersList": "Issues qui attendent des réponses",
  "queue.answersEmpty": "Aucune issue n’attend vos réponses.",
  "queue.queuedList": "Tâches qui attendent un emplacement, dans l’ordre de lancement",
  "queue.queuedEmpty": "Rien n’attend d’emplacement.",
  "queue.loading": "Chargement…",
  "queue.configErrors":
    "Le .deckhand.yaml de {repo} contient des erreurs : rien ne démarre tant qu’elles ne sont pas corrigées.",
  "queue.unreadable": "Impossible de lire les issues ({error}).",
  "queue.notIssueLink":
    "Ce n’est pas un lien vers une issue de {repo} : glissez la carte d’une issue depuis le backlog, ou son lien.",
  "queue.filter": "Filtrer le backlog",
  "queue.filterPlaceholder": {
    one: "Filtrer {count} issue ouverte",
    other: "Filtrer {count} issues ouvertes",
  },

  // A tab's hint: what its cards' drags do.
  "queue.hintBacklog":
    "Glissez sur le tableau pour lancer · sur une carte pour passer après elle · sur l’onglet Brainstorm pour un brainstorm.",
  "queue.hintBrainstorm":
    "Glissez sur le tableau pour lancer le travail · sur une carte pour passer après elle · sur l’onglet Backlog pour arrêter.",
  "queue.hintWaiting":
    "Sur le tableau, écartez une carte en attente pour mettre fin à son attente, ou déposez-la sur une autre carte pour qu’elle attende celle-ci.",
  "queue.hintAnswers":
    "Glissez sur le tableau pour répondre et lancer · sur une carte pour répondre et passer après elle.",
  "queue.hintQueued":
    "L’ordre de lancement quand un emplacement se libère · glissez au-dessus ou en dessous d’une autre carte pour déplacer · sur une carte du tableau pour passer après elle · sur l’onglet Backlog pour la retirer. Les brainstorms démarrent en premier.",

  // A card: its name without a title, the line under it, its status while dragged.
  "queue.untitled": "Issue #{number}",
  "queue.inLine": "{position} dans l’ordre",
  "queue.startsFirst": "démarre en premier",
  "queue.subIssues": {
    one: "{count} sous-issue · lancer la dispose",
    other: "{count} sous-issues · lancer les dispose",
  },
  "queue.openQuestions": { one: "{count} question ouverte", other: "{count} questions ouvertes" },
  "queue.openQuestionsUncounted": "Questions ouvertes",
  "queue.dragBacklog": "Backlog",
  "queue.dragAnswer": "Répondre",
  "queue.more": "Plus pour #{number} : {actions}",

  // A card's buttons, and their names when the label doesn't say which issue.
  "queue.runNext": "Lancer ensuite",
  "queue.runNextAria": "Lancer #{number} ensuite",
  "queue.moveUp": "Monter",
  "queue.moveUpAria": "Monter #{number}",
  "queue.moveDown": "Descendre",
  "queue.moveDownAria": "Descendre #{number}",
  "queue.after": "Après…",
  "queue.afterAria": "Mettre #{number} en file après…",
  "queue.toBacklog": "Au backlog",
  "queue.toBacklogAria": "Retirer #{number} de la file, retour au backlog",
  "queue.start": "Lancer",
  "queue.startAria": "Lancer #{number}",
  "queue.brainstormAction": "Brainstorm",
  "queue.brainstormAria": "Brainstorm sur #{number}",
  "queue.startWork": "Lancer le travail",
  "queue.startWorkAria": "Lancer le travail sur #{number}",
  "queue.stop": "Arrêter",
  "queue.stopAria": "Arrêter le brainstorm de #{number}",
  "queue.startNow": "Lancer maintenant",
  "queue.startNowAria": "Lancer #{number} maintenant",
  "queue.removeWait": "Retirer l’attente",
  "queue.removeWaitAria": "Retirer l’attente de #{number}",
  "queue.answer": "Répondre",
  "queue.answerAria": "Répondre à #{number} et la lancer",
  "queue.answerQueue": "Répondre, puis mettre en file…",
  "queue.answerQueueAria": "Répondre à #{number}, puis la mettre en file après…",
} satisfies Section<typeof en>;
