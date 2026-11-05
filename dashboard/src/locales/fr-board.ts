// French texts of the board: its toolbar and drags (Board.tsx, dnd.ts), the graph
// (GraphDrawing.tsx, GraphLegend.tsx, graphModel.ts) and the lanes (Lanes.tsx, lanes.ts): spread
// into the French catalog (fr.ts).
import type { Section } from ".";
import type { board as en } from "./en-board";

export const board = {
  // Board.tsx: its toolbar, options and notices.
  "board.startIn": "Lancer en",
  "board.startInBox": "Lancer en {select}",
  "board.showClosed": "Afficher les fermées",
  "board.showClosedHelp":
    "Issues fermées comme terminées ou non prévues, et pull requests fusionnées",
  "board.graph": "Graphe",
  "board.lanes": "Colonnes",
  "board.view": "Vue du tableau",
  "board.options": "Options du tableau",
  "board.canvas": "Qui attend quoi",
  "board.zoomOut": "Dézoomer",
  "board.zoomIn": "Zoomer",
  "board.zoomReset": "Revenir à 100 %",
  "board.zoomResetLabel": "Zoom {percent} % : revenir à 100 %",
  "board.percent": "{percent} %",
  "board.fit": "Ajuster",
  "board.notALink":
    "Ce n’est pas un lien vers une issue de {repo} : glissez la carte d’une issue depuis la file de travail, ou son lien.",

  // Board.tsx: what letting a drag go does, said where it would happen. `{ref}` is "#31", or
  // drag.theIssue for a link not read yet; `{node}` the node's "#19".
  "drag.theIssue": "l’issue",
  "drag.moveAfter": "Placer #{number} après {node} dans l’ordre",
  "drag.moveBefore": "Placer #{number} avant {node} dans l’ordre",
  "drag.leaveLine": "Mettre #{number} en file après {node} : elle quitte l’ordre",
  "drag.queueAfter": "Mettre {ref} en file après {node}",
  "drag.layOutAfter": "Disposer {ref} après {node}",
  "drag.removeWait": "Retirer l’attente de {ref}",
  "drag.startWork": "Lancer le travail sur {ref}",
  "drag.layOut": "Disposer {ref} et ses sous-issues",
  "drag.start": "Lancer {ref}",
  "drag.startIn": "Lancer {ref} en {mode}",
  // The same, its open questions answered first.
  "drag.answerQueueAfter": "Répondre à {ref}, puis mettre en file après {node}",
  "drag.answerLayOutAfter": "Répondre à {ref}, puis disposer après {node}",
  "drag.answerStartWork": "Répondre à {ref}, puis lancer le travail",
  "drag.answerLayOut": "Répondre à {ref}, puis la disposer avec ses sous-issues",
  "drag.answerStart": "Répondre à {ref}, puis lancer",
  "drag.answerStartIn": "Répondre à {ref}, puis lancer en {mode}",

  // graphModel.ts: the legend's tones, and what each means.
  "graph.lookRunning": "En cours",
  "graph.lookRunningMeans": "en cours de traitement",
  "graph.lookInput": "Pour vous",
  "graph.lookInputMeans": "des questions à répondre, ou le tour d’un brainstorm",
  "graph.lookReady": "Prête pour la revue",
  "graph.lookReadyMeans": "CI réussie, aucun conflit, boucle de revue propre",
  "graph.lookError": "Erreur",
  "graph.lookErrorMeans": "échouée : ce qui l’attend continue d’attendre",
  "graph.lookWaiting": "En attente",
  "graph.lookWaitingMeans":
    "d’un bloqueur, en file, ou rien de lancé ; estompée : fermée comme terminée, non fusionnée",
  "graph.lookMerged": "Fusionnée",
  "graph.lookMergedMeans": "sa pull request est fusionnée",

  // graphModel.ts: what a node or card says while an action on it is on its way.
  "graph.starting": "Lancement…",
  "graph.queueing": "Mise en file…",
  "graph.layingOut": "Disposition…",
  "graph.removingWait": "Retrait de l’attente…",
  "graph.backToBacklog": "Retour au backlog…",
  "graph.stopping": "Arrêt en cours…",
  "graph.sending": "Envoi…",

  // graphModel.ts: a node's state, where the list's word won't do.
  "graph.mergedByDeckhand": "Fusionnée par Deckhand",
  "graph.merged": "Fusionnée",
  "graph.implemented": "Implémentée",
  "graph.inputPrReady": "Réponse attendue, PR prête",
  "graph.notPlanned": "Fermée, non prévue",
  "graph.runDone": "Exécution terminée",
  "graph.open": "Ouverte",

  // graphModel.ts ordinal(): a place in the run order, by Intl.PluralRules' ordinal forms.
  "graph.ordinalZero": "{n}e",
  "graph.ordinalOne": "{n}re",
  "graph.ordinalTwo": "{n}e",
  "graph.ordinalFew": "{n}e",
  "graph.ordinalMany": "{n}e",
  "graph.ordinalOther": "{n}e",

  // GraphDrawing.tsx: a node, and why there is nothing to draw (the lanes' too).
  "graph.untitled": "{kind} {ref}",
  "graph.nodeTitle": "{title} ({status})",
  "graph.nodeLabel": "{node} : {status}{details}",
  "graph.labelInLine": ", {place} dans l’ordre",
  "graph.labelQuestions": { one: ", {count} question", other: ", {count} questions" },
  "graph.labelWaits": { one: ", attend {count} issue", other: ", attend {count} issues" },
  "graph.placeTitle": "{place} dans l’ordre de lancement",
  "graph.issuesOf": "Issues de {repo}",
  "graph.loading": "Chargement…",
  "graph.nothingOpen": "Rien d’ouvert ici. {show}",
  "graph.showClosedIssues": "Afficher les issues fermées",
  "graph.empty": "Aucune issue ici pour l’instant. Déposez-en une ici pour la lancer.",

  // GraphLegend.tsx.
  "graph.legend": "Légende",
  "graph.waitsFor": "attend",
  "graph.waitsForHelp": "Elle démarre une fois terminée l’issue d’où part la flèche",

  // Lanes.tsx, and lanes.ts's name for a lane nothing names.
  "lanes.andMore": { one: "{first} et {count} autre", other: "{first} et {count} autres" },
  "lanes.empty": "Aucune issue ici pour l’instant.",
  "lanes.alone": "Indépendantes",
  "lanes.lane": "Colonne {name}",
  "lanes.name": "Nom de la colonne",
  "lanes.namePlaceholder": "Vide : sans nom",
  "lanes.rename": "Renommer la colonne {name}",
  "lanes.saving": "Enregistrement…",
  "lanes.save": "Enregistrer",
  "lanes.cancel": "Annuler",
} satisfies Section<typeof en>;
