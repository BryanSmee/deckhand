// French texts of a task's page (Detail.tsx), its run's outcome, CI, review loop, Stop's question
// and All runs: spread into the French catalog (fr.ts).
import type { Section } from ".";
import type { detail as en } from "./en-detail";

export const detail = {
  // Detail.tsx: the task page's header, actions, facts and tabs.
  "detail.pick": "Choisissez une issue ou une pull request",
  "detail.logCopied": "Journal copié.",
  "detail.copyFailed": "Impossible de copier le journal : téléchargez-le plutôt.",
  "detail.stoppingSent": "Arrêt en cours.",
  "detail.rerunQueued": "Relance en file.",
  "detail.fixQueued": "Tour de correction en file.",
  "detail.reviewQueued": "Revue en file.",
  "detail.dismissUndone": "Mise à l’écart annulée.",
  "detail.dismissedSent": "Écartée : elle ne vous attend plus.",
  "detail.fix": "Corriger",
  "detail.fixing": "Correction…",
  "detail.fixHelp":
    "Une exécution de correction de plus sur les remarques de la dernière revue, puis sa revue",
  "detail.review": "Relire",
  "detail.reviewing": "Relecture…",
  "detail.reviewHeadHelp": "Relit le nouveau head, {sha}, comme le fait /mode review",
  "detail.reviewHelp": "Relit maintenant le head de la pull request, comme le fait /mode review",
  "detail.thread": "Fil",
  "detail.policies": "Politiques",
  "detail.latestTab": "Dernière : suit les prochaines exécutions",
  "detail.reviewTab": "Revue",
  // The tabs' list ("Thread, runs and review"): each in it, joined by and().
  "detail.tabsThread": "fil",
  "detail.tabsRuns": "exécutions",
  "detail.tabsPolicies": "politiques",
  "detail.tabsReview": "revue",
  "detail.back": "Retour",
  "detail.more": "Plus : ouvrir sur GitHub, copier, télécharger",
  "detail.mode": "mode {mode}",
  "detail.openGithub": "Ouvrir sur GitHub",
  "detail.github": "GitHub",
  "detail.rerun": "Relancer",
  "detail.rerunning": "Relance…",
  "detail.rerunHelp": "La relance avec les mêmes commentaires et le même mode",
  "detail.dismiss": "Écarter",
  "detail.dismissing": "Mise à l’écart…",
  "detail.dismissHelp": "Elle ne vous attend plus jusqu’à la prochaine exécution",
  "detail.stop": "Arrêter",
  "detail.stopping": "Arrêt en cours…",
  "detail.stopHelp":
    "Arrête l’exécution maintenant : ce qu’elle a fait depuis son dernier push est perdu",
  "detail.unqueue": "Retirer de la file",
  "detail.removing": "Retrait…",
  "detail.unqueueHelp": "La retire de la file : ses commentaires en file sont abandonnés",
  "detail.held": "Pas fusionnée automatiquement",
  "detail.started": "Lancée {when} · {took}",
  // A run's model, its effort and speed: "opus · high effort · fast".
  "detail.effort": "effort {effort}",
  "detail.fast": "rapide",
  "detail.dismissedBy": "Écartée par @{user} {ago}",
  "detail.undoing": "Annulation…",
  "detail.undoHelp":
    "Annule la mise à l’écart : un échec qui demande encore une action vous attend de nouveau",
  "detail.undo": "Annuler",
  "detail.nextRunAfter": "Prochaine exécution après {issues}",
  "detail.repliesOn": "Réponses sur #{number}",
  "detail.lastReply": "Dernière réponse",
  "detail.runLog": "Journal d’exécution",
  "detail.copyLog": "Copier le journal",
  "detail.download": "Télécharger en .txt",
  "detail.noLogs":
    "Son journal ne vous est pas accessible : vous n’avez pas {permission} sur {repo}.",
  "detail.waitingAnswers": "En attente de réponses à ses questions ouvertes",
  "detail.waitingAnswersGithub": "En attente de réponses à ses questions ouvertes sur GitHub",
  "detail.waitingFirstRun": "En attente du lancement de la première exécution de {title}…",
  "detail.mergedByDeckhand": "Fusionnée par Deckhand",

  // Outcome.tsx: how the run shown ended, and what to do next.
  "outcome.merged": "Fusionnée",
  "outcome.draft": "Pull request brouillon",
  "outcome.ready": "Pull request prête pour la revue",
  "outcome.closed": "Pull request fermée",
  "outcome.withStatus": "{label} · {status}",
  "outcome.ranOn": "Exécutée avec {variable}",
  "outcome.commits": { one: "{count} commit", other: "{count} commits" },
  "outcome.openPr": "Ouvrir la pull request {number}",
  "outcome.outcome": "Résultat",
  "outcome.working": "En cours… le journal ci-dessous la suit en direct.",
  // "+12 −3 in 2 files".
  "outcome.changedIn": {
    one: "{changed} dans {count} fichier",
    other: "{changed} dans {count} fichiers",
  },
  "outcome.replyOn": "Réponse sur #{number}",

  // CiStatus.tsx: what CI says of a pull request.
  "ci.running": "CI en cours",
  "ci.passed": "CI réussie",
  "ci.failed": "CI échouée",
  "ci.failedRuns": "CI échouée : {names}",

  // ReviewLoop.tsx: the review-and-fix loop's marks and rounds.
  "reviewLoop.outdatedTitle": "Revue de {reviewed}, le head est maintenant {head}",
  "reviewLoop.outdated": "Revue périmée",
  "reviewLoop.reviewing": "Revue en cours",
  "reviewLoop.fixing": "Correction en cours",
  "reviewLoop.checks": "En attente des checks",
  "reviewLoop.ci": "En attente de la CI",
  "reviewLoop.ciFix": "Correction de la CI",
  "reviewLoop.ciFailed": "CI échouée, pas relue",
  "reviewLoop.clean": "Rien de bloquant",
  "reviewLoop.roundsOut": "Tours de correction épuisés",
  "reviewLoop.fixed": "Corrigée, pas relue depuis",
  "reviewLoop.stopped": "Arrêtée",
  "reviewLoop.blocking": "Remarques bloquantes",
  "reviewLoop.reviews": "Revues",
  "reviewLoop.loop": "Boucle de revue",
  "reviewLoop.outdatedLine": "Périmée : revue de {reviewed}, le head est maintenant {head}",
  "reviewLoop.better": "mieux que la revue précédente",
  "reviewLoop.worse": "moins bien que la revue précédente",
  "reviewLoop.last": "Dernière revue :",
  "reviewLoop.every": "Toutes les revues, de la plus ancienne à la plus récente",
  // An entry's title: "Review after fix round 2 of 3: 1 blocking".
  "reviewLoop.maintainer": "Revue d’un mainteneur, bloquantes : {blocking}",
  "reviewLoop.afterRoundOf":
    "Revue après le tour de correction {round} sur {rounds}, bloquantes : {blocking}",
  "reviewLoop.afterRound": "Revue après le tour de correction {round}, bloquantes : {blocking}",
  "reviewLoop.first": "Première revue, bloquantes : {blocking}",
  "reviewLoop.round": "T{round}",
  "reviewLoop.noProgress": "aucun progrès",

  // Stop.tsx: Stop's question, what a run's end loses and what stays.
  "stop.when": "{time}, {ago}",
  "stop.pr": "la pull request #{number}",
  "stop.draftPr": "la pull request brouillon #{number}",
  "stop.notPushedPr":
    "Elle s’arrête maintenant. Elle n’a encore rien poussé : ce qu’elle a fait est perdu ; {pr} reste en l’état.",
  "stop.notPushed":
    "Elle s’arrête maintenant. Elle n’a encore rien poussé : ce qu’elle a fait est perdu.",
  "stop.pushedAtPr":
    "Elle s’arrête maintenant. Ce qu’elle a fait depuis son dernier push ({when}) est perdu ; la branche et {pr} restent en l’état.",
  "stop.pushedAt":
    "Elle s’arrête maintenant. Ce qu’elle a fait depuis son dernier push ({when}) est perdu ; la branche reste en l’état.",
  "stop.pushedPr":
    "Elle s’arrête maintenant. Ce qu’elle a fait depuis son dernier push est perdu ; la branche et {pr} restent en l’état.",
  "stop.pushed":
    "Elle s’arrête maintenant. Ce qu’elle a fait depuis son dernier push est perdu ; la branche reste en l’état.",
  "stop.title": "Arrêter l’exécution sur {number} ?",
  "stop.keep": "Continuer",
  "stop.confirm": "Arrêter l’exécution",

  // RunMenu.tsx: All runs, its button and list.
  "runMenu.all": "Toutes les exécutions",
  "runMenu.list": "Toutes les exécutions, de la plus récente à la plus ancienne",
  "runMenu.when": "{when} · {took}",
} satisfies Section<typeof en>;
