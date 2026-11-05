// French texts of New request and Analyze runs (NewRequest.tsx, Analyze.tsx): spread into the French catalog (fr.ts).
import type { Section } from ".";
import type { request as en } from "./en-request";

export const request = {
  // New request: the dialog, its kinds and what each one does
  "request.title": "Nouvelle demande",
  "request.cancel": "Annuler",
  "request.kind": "Type",
  "request.repository": "Dépôt",
  "request.kindIdea": "Idée",
  "request.kindBug": "Rapport de bug",
  "request.kindDiscussion": "Discussion",
  "request.kindAnalyze": "Analyser les exécutions",
  "request.subInbox":
    "Va dans la boîte de réception de son dépôt, que l’exécution de la boîte de réception traitera.",
  "request.subDiscussion": "Lance une discussion dans son dépôt : Deckhand y répond.",
  "request.subAnalyze":
    "Une exécution lit un résumé des exécutions choisies et répond sur une nouvelle issue avec ce qui les rendrait plus rapides ou plus fiables. Elle ne modifie aucun code.",

  // New request: why no repository is offered, a sentence per kind
  "request.cantAnalyze": "Vous ne pouvez lancer d’analyse sur aucun de ces dépôts.",
  "request.cantSendIdeas": "Vous ne pouvez envoyer d’idées à aucun de ces dépôts.",
  "request.cantSendBugs": "Vous ne pouvez envoyer de rapports de bug à aucun de ces dépôts.",
  "request.cantSendDiscussions": "Vous ne pouvez envoyer de discussions à aucun de ces dépôts.",
  "request.nothingToAnalyze": "Aucun dépôt n’a encore d’exécutions à analyser.",
  "request.repoNoIdeas": "{repo} n’a pas de boîte de réception pour les idées.",
  "request.repoNoBugs": "{repo} n’a pas de boîte de réception pour les rapports de bug.",
  "request.repoNoDiscussions": "{repo} n’a pas de boîte de réception pour les discussions.",
  "request.noIdeas": "Aucun dépôt n’a de boîte de réception pour les idées.",
  "request.noBugs": "Aucun dépôt n’a de boîte de réception pour les rapports de bug.",
  "request.noDiscussions": "Aucun dépôt n’a de boîte de réception pour les discussions.",
  "request.loading": "Chargement…",
  "request.setUp": "En configurer une",

  // Analyze runs: the form
  "request.analysis": "Analyse",
  "request.runsToRead": "Exécutions à lire",
  "request.pickOneOrMore": "Choisissez 1 exécution ou plus.",
  "request.pickUpTo": "Choisissez de 1 à {max} exécutions.",
  "request.mostRecent": "Les plus récentes.",
  "request.mostRecentMax": "Les plus récentes, {max} au plus.",
  "request.kinds": "Types",
  "request.noFinishedRuns": "Aucune exécution terminée pour l’instant.",
  "request.outcomes": "Résultats",
  "request.outcomeOk": "Réussie",
  "request.outcomeError": "Erreur",
  "request.outcomeNeedsInput": "Réponse attendue",
  "request.outcomeInterrupted": "Interrompue",
  "request.outcomeCancelled": "Annulée",
  "request.warning":
    "C’est une grosse exécution : elle utilise le budget Claude de l’opérateur, avec le modèle des exécutions légères.",

  // Analyze runs: the footer's action
  "request.analyze": "Analyser",
  "request.analyzeRuns": {
    one: "Analyser {count} exécution",
    other: "Analyser {count} exécutions",
  },
  "request.starting": "Lancement…",

  // Analyze runs: the preview
  "request.counting": "Décompte des exécutions…",
  "request.matching": {
    one: "{count} exécution correspond, environ {tokens} jetons à lire.",
    other: "{count} exécutions correspondent, environ {tokens} jetons à lire.",
  },
  "request.leftOut": {
    one: "{count} exécution plus ancienne écartée : au-delà du plafond du résumé.",
    other: "{count} exécutions plus anciennes écartées : au-delà du plafond du résumé.",
  },
  "request.noMatch": "Aucune exécution ne correspond : choisissez d’autres types ou résultats.",

  // Analyze runs: once started
  "request.started": "Lancée : {issue}",
  "request.issue": "issue #{number}",
  "request.itsRun": "son exécution",
  "request.itsRunStatus": "son exécution ({status})",
} satisfies Section<typeof en>;
