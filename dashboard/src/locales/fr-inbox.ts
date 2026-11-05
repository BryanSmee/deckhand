// French texts of Inbox, the task list and Sync (Inbox.tsx, TaskList.tsx, Sync.tsx): spread into the French catalog (fr.ts).
import type { Section } from ".";
import type { inbox as en } from "./en-inbox";

export const inbox = {
  // New request's idea, bug report or discussion form
  "inbox.sendIdea": "Envoyer l’idée",
  "inbox.ideaTitle": "Ce que vous voulez, en une ligne",
  "inbox.ideaDetails": "Ce que vous voulez, et pourquoi. Markdown accepté.",
  "inbox.sendBug": "Envoyer le rapport",
  "inbox.bugTitle": "Ce qui ne va pas, en une ligne",
  "inbox.bugDetails": "Ce qui ne va pas, et comment le constater. Markdown accepté.",
  "inbox.startDiscussion": "Lancer la discussion",
  "inbox.discussionTitle": "Le titre de la discussion",
  "inbox.discussionDetails": "Ce dont vous voulez parler. Markdown accepté.",
  "inbox.starting": "Lancement…",
  "inbox.sending": "Envoi…",
  "inbox.title": "Titre",
  "inbox.details": "Détails",
  "inbox.detailsOptional": "Détails {optional}",
  "inbox.optional": "· facultatif",
  "inbox.discussionHelp": "Deckhand répond dans la discussion.",
  "inbox.entryHelp":
    "L’exécution de la boîte de réception en fait une issue prête à lancer, ou vous pose d’abord ses questions. Terminez une ligne par /effort high, /model ou /agent pour les choisir pour son exécution.",

  // Once sent: the comment's or discussion's link, then its task's
  "inbox.sent": "Envoyé : {what}",
  "inbox.sentWithTask": "Envoyé : {what} · {task}",
  "inbox.theComment": "le commentaire",
  "inbox.theDiscussion": "la discussion",
  "inbox.itsThread": "son fil",
  "inbox.itsRun": "son exécution ({status})",
  "inbox.inboxTask": "la tâche de la boîte de réception",

  // The task list
  "taskList.search": "Rechercher des tâches",
  "taskList.state": "État",
  "taskList.filter": "Filtre : {name}",
  "taskList.loading": "Chargement…",
  "taskList.noRuns": "Aucune exécution pour l’instant",
  "taskList.noMatch": "Aucune tâche ne correspond à « {query} »",
  "taskList.noneInState": "Rien dans cet état",

  // The task list's chips (format.ts CHIPS)
  "chips.all": "Toutes",
  "chips.running": "En cours",
  "chips.input": "Vous attend",
  "chips.review": "Prêtes",
  "chips.done": "Terminées",
  "chips.error": "Erreur",

  // Sync with GitHub
  "sync.upToDate": "À jour avec GitHub",
  "sync.synced": "Synchronisé : {done}",
  "sync.redelivered": {
    one: "{count} livraison manquée redemandée",
    other: "{count} livraisons manquées redemandées",
  },
  "sync.pulls": {
    one: "{count} pull request mise à jour",
    other: "{count} pull requests mises à jour",
  },
  "sync.conflicts": {
    one: "{count} exécution de rebase lancée",
    other: "{count} exécutions de rebase lancées",
  },
  "sync.failed": "Synchronisation impossible ({error})",
} satisfies Section<typeof en>;
