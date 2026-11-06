// French texts of a task's Review tab (ReviewTab.tsx): spread into the French catalog (fr.ts).
import type { Section } from ".";
import type { review as en } from "./en-review";

export const review = {
  "reviewTab.missing":
    "Aucune revue de Deckhand à afficher ici : GitHub a refusé la dernière, publiée à la place en commentaire sur la pull request, ou elle n’est pas au format de Deckhand.",
  "reviewTab.readFailed": "Impossible de lire la dernière revue : {error}",
  "reviewTab.readAgainFailed": "Impossible de la relire : {error}",
  "reviewTab.tryAgain": "Réessayer",
  "reviewTab.reading": "Lecture de la dernière revue",
  "reviewTab.merged": "#{number} fusionnée",
  "reviewTab.mergedBy": "#{number} fusionnée par {who}",
  "reviewTab.mergedAt": "{merged} {when}",

  "reviewTab.requestChanges": "Demande des changements",
  "reviewTab.comment": "Commentaire",
  "reviewTab.approve": "Approuve",
  "reviewTab.maintainer": "Revue d’un mainteneur",
  "reviewTab.afterRound": "Revue après le tour de correction {round}",
  "reviewTab.first": "Première revue",
  "reviewTab.round": "T{round}",
  "reviewTab.rating": "{rating}/10",
  "reviewTab.reviewed": "revue de {sha}",
  "reviewTab.outdated": "Périmée : le head est maintenant {head}",
  "reviewTab.github": "Sur GitHub",

  "reviewTab.mustFix": "À corriger",
  "reviewTab.nothingToFix": "Rien à corriger.",
  "reviewTab.critical": "Critique",
  "reviewTab.high": "Élevée",
  "reviewTab.medium": "Moyenne",
  "reviewTab.low": "Mineure",
  "reviewTab.mergedWith": "fusionnée avec",
  "reviewTab.tolerated": "tolérée",
  "reviewTab.toleratedHelp": "Le review.max_allowed_severity du dépôt est {severity}",
  "reviewTab.toFix": "à corriger",

  "reviewTab.followUps": "Suivis",
  "reviewTab.followUpsMerged":
    "Pour d’autres issues : Deckhand ouvre chacun maintenant qu’elle est fusionnée.",
  "reviewTab.followUpsOpen":
    "Pour d’autres issues : Deckhand ouvre chacun une fois qu’elle est fusionnée.",
  "reviewTab.issueOpen": "ouverte",
  "reviewTab.issueClosed": "fermée",
  "reviewTab.filingAfterMerge": "ouvert après la fusion",
  "reviewTab.filingFailed": "ouverture échouée : GitHub a refusé l’issue",
  "reviewTab.filingLeft": "non ouvert : au-delà des suivis que Deckhand ouvre par pull request",
  "reviewTab.filingOff": "non ouvert : laissé à vos soins (review.follow_ups: false)",
  "reviewTab.filingUnread": "inconnu : la configuration du dépôt est illisible",
  "reviewTab.filingNotFiled": "non ouvert : rien ne l’a ouvert à la fusion",
  "reviewTab.filingUnknown": "ouvert avant que Deckhand ne note quelle issue",

  "reviewTab.comments": "Commentaires",
  "reviewTab.blocking": "bloquant",
  "reviewTab.note": "note",
} satisfies Section<typeof en>;
