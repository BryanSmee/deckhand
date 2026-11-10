// French texts of Chats (Chats.tsx, Conversation.tsx, ChatPermissions.tsx, PermissionCard.tsx, chatModel.ts): spread into the French catalog (fr.ts).
import type { Section } from ".";
import type { chats as en } from "./en-chats";

export const chats = {
  // The page and its list
  "chats.yours": "Vos conversations",
  "chats.kept": "{kept} sur {limit}",
  "chats.keptTitle": "Les conversations que vous gardez, sur le maximum autorisé",
  "chats.newChat": "Nouvelle conversation",
  "chats.loading": "Chargement…",
  "chats.noneAllowed": "Aucune conversation ici : CHATS_PER_USER vaut 0.",
  "chats.atLimit":
    "Vous gardez {kept} conversations sur {limit}, le maximum autorisé : supprimez-en une pour en commencer une autre.",
  "chats.noRepository": "Aucun dépôt ne vous permet de commencer une conversation.",
  "chats.cantRead": "Impossible de lire vos conversations ({error})",
  "chats.noneOn": "Pas encore de conversation sur {repo}.",
  "chats.none": "Pas encore de conversation.",
  "chats.noSuchChatOn":
    "Conversation introuvable sur {repo} : elle a été supprimée, ou elle n’est pas à vous.",
  "chats.noSuchChat": "Conversation introuvable : elle a été supprimée, ou elle n’est pas à vous.",
  "chats.pick": "Choisissez une conversation, ou commencez-en une.",
  "chats.intro":
    "Commencez une conversation pour interroger l’agent sur un dépôt, ou pour essayer des choses dans sa propre sandbox. Il peut lire les issues et les pull requests du dépôt, mais n’écrit rien sur GitHub.",

  // The open chat's header and menu
  "chats.back": "Retour à vos conversations",
  "chats.effort": "effort {effort}",
  "chats.close": "Fermer",
  "chats.menu": "Menu de la conversation",
  "chats.permissionsItem": "Permissions…",
  "chats.resetItem": "Réinitialiser…",
  "chats.deleteItem": "Supprimer…",

  // Reset and Delete, asked first
  "chats.resetTitle": "Réinitialiser cette conversation ?",
  "chats.resetSub":
    "Sa sandbox s’arrête, et son clone du dépôt et la session de l’agent sont supprimés : ce que l’agent y a modifié et ce dont il se souvient de cette conversation sont perdus. La conversation reste, et votre prochain message repart d’un clone neuf.",
  "chats.resetAction": "Réinitialiser",
  "chats.resetting": "Réinitialisation…",
  "chats.deleteTitle": "Supprimer cette conversation ?",
  "chats.deleteSub":
    "Sa sandbox s’arrête, et la conversation disparaît avec son clone du dépôt, la session de l’agent et tous les messages. Impossible de revenir en arrière.",
  "chats.deleteAction": "Supprimer",
  "chats.deleting": "Suppression…",
  "chats.cancel": "Annuler",

  // New chat
  "chats.newSub":
    "Une sandbox dédiée sur le dépôt, en lecture seule sur GitHub. Elle s’arrête après un moment sans message, et redémarre au suivant.",
  "chats.starting": "Démarrage…",
  "chats.start": "Commencer",
  "chats.repository": "Dépôt",
  "chats.agent": "Agent",
  "chats.model": "Modèle",
  "chats.effortLabel": "Effort",
  "chats.repositoryDefault": "Celui du dépôt",
  "chats.firstMessage": "Premier message",
  "chats.firstMessageHelp":
    "Facultatif : il démarre la sandbox. Ctrl Enter commence la conversation.",

  // The chat's state (chatModel.ts)
  "chats.stateStarting": "Démarrage",
  "chats.stateResuming": "Reprise",
  "chats.stateWaiting": "Attend un emplacement",
  "chats.stateWorking": "En cours",
  "chats.stateIdle": "Inactive",
  "chats.stateStopped": "Arrêtée",
  "chats.noteStarting": "Sa sandbox démarre : un clone du dépôt.",
  "chats.noteResuming": "Sa sandbox redémarre, dans la même session.",
  "chats.noteWaiting":
    "Les sandboxes d’autres conversations occupent tous les emplacements : elle démarre dès qu’un se libère.",
  "chats.noteWorking": "L’agent s’en occupe.",
  "chats.noteIdle": "Sa sandbox attend votre prochain message.",
  "chats.noteStopped":
    "Pas de sandbox pour l’instant : votre prochain message la redémarre, là où la conversation s’était arrêtée.",
  "chats.noteFresh":
    "Pas de sandbox pour l’instant : votre prochain message la démarre, depuis un clone neuf du dépôt.",
  "chats.noteRequests": {
    one: "L’agent attend votre réponse à sa demande ci-dessus.",
    other: "L’agent attend votre réponse à ses demandes ci-dessus.",
  },
  "chats.agentFailed": "L’agent a échoué.",

  // The conversation
  "chats.conversation": "Conversation",
  "chats.showEarlier": {
    one: "Voir les précédents ({count} autre exécution de sandbox)",
    other: "Voir les précédents ({count} autres exécutions de sandbox)",
  },
  "chats.empty":
    "Posez n’importe quelle question sur {repo} : votre premier message démarre sa sandbox.",
  "chats.unreachable":
    "Vous ne pouvez plus lancer l’agent sur ce dépôt : vous pouvez seulement supprimer cette conversation.",
  "chats.notSent": "Non envoyé : {error}",
  "chats.message": "Message",
  "chats.messagePlaceholder": "Écrire à l’agent",
  "chats.noMessages": "Cette conversation n’accepte pas de message",
  "chats.send": "Envoyer",
  "chats.sendTitle": "Envoyer (Enter ; Shift Enter ajoute une ligne)",
  "chats.sandboxStarted": "Sandbox démarrée {when}",
  "chats.sandboxResumed": "Sandbox reprise {when}",
  "chats.chatReset":
    "Conversation réinitialisée {when} : clone et session neufs, l’agent ne se souvient de rien de ce qui précède",
  "chats.sending": "Envoi…",
  "chats.queued": "En file : l’agent le reçoit dès que sa sandbox est prête",
  "chats.sent": "Envoyé",
  "chats.toolCalls": { one: "{count} appel d’outil", other: "{count} appels d’outils" },
  "chats.lines": { one: "{count} ligne", other: "{count} lignes" },
  "chats.phaseNow": "{phase}…",

  // The agent's requests for more permissions (PermissionCard.tsx)
  "chats.asksHost": "L’agent demande un hôte",
  "chats.asksGithub": "L’agent demande un accès GitHub",
  "chats.asksEngine": "L’agent demande un moteur de conteneurs",
  "chats.asksMount": "L’agent demande un montage de l’hôte",
  "chats.asksWhat": "{asks} : {what}",
  "chats.appliesNow": "S’applique tout de suite à sa sandbox.",
  "chats.appliesLater":
    "S’applique au redémarrage de sa sandbox : « Redémarrer maintenant », dans les permissions de la conversation, une fois que l’agent a répondu.",
  "chats.deniedIn": {
    one: "Refusée dans {count} minute faute de réponse.",
    other: "Refusée dans {count} minutes faute de réponse.",
  },
  "chats.approveOnce": "Approuver une fois",
  "chats.approveChat": "Approuver pour la conversation",
  "chats.deny": "Refuser",

  // The chat's permissions (ChatPermissions.tsx)
  "chats.permissions": "Permissions",
  "chats.permissionsLoading": "Chargement des permissions…",
  "chats.permissionsNote":
    "Ce que la sandbox de cette conversation peut faire, dans la limite de ce que les autorisations de l’opérateur et les politiques du dépôt accordent à une conversation. Appliqué dans la sandbox ; les changements prennent effet à son prochain démarrage.",
  "chats.permissionsDocs": "Comment les conversations sont confinées",
  "chats.wouldntStart":
    "La prochaine exécution de cette conversation ne démarrerait pas, quelles que soient ses permissions :",
  "chats.github": "GitHub",
  "chats.levelRead": "Lecture seule",
  "chats.levelComment": "Commenter les issues",
  "chats.levelPush": "Pousser sa propre branche et ouvrir une pull request brouillon",
  "chats.capabilities": "Capacités",
  "chats.capPull": "Le code du dépôt",
  "chats.capSetup": "Commande de préparation",
  "chats.capImageRepo": "L’image du dépôt",
  "chats.capImageBranch": "L’image d’une pull request",
  "chats.capDocker": "Moteur de conteneurs",
  "chats.capInternet": "Internet ouvert",
  "chats.capReadIssues": "Lire les issues",
  "chats.capReadPulls": "Lire les pull requests",
  "chats.capReadDiscussions": "Lire les discussions",
  "chats.capReadActions": "Lire les résultats de la CI",
  "chats.capReadContext": "Lire les dépôts de contexte",
  "chats.network": "Réseau",
  "chats.noHosts":
    "L’opérateur n’accorde à ce dépôt aucun hôte au-delà de ceux dont toute exécution a besoin.",
  "chats.internetOn": "Avec Internet ouvert activé, la sandbox atteint n’importe quel hôte public.",
  "chats.hostsNeeded":
    "Les hôtes dont toute exécution a besoin (l’API de l’agent, GitHub) restent joignables. Un hôte absent des autorisations ne peut pas être ajouté ici.",
  "chats.mounts": "Montages",
  "chats.readWrite": "Lecture-écriture, comme accordé",
  "chats.readOnly": "Lecture seule : {reason}",
  "chats.notSaved": "Non enregistré : cela dépasse ce que la conversation peut obtenir.",
  "chats.savedRunning":
    "Enregistré. La sandbox en cours garde les permissions avec lesquelles elle a démarré : redémarrez-la pour utiliser celles-ci.",
  "chats.savedNext": "Enregistré. Le prochain message démarre la sandbox avec ces permissions.",
  "chats.restarting": "Redémarrage…",
  "chats.restartNow": "Redémarrer maintenant",
  "chats.saving": "Enregistrement…",
  "chats.save": "Enregistrer",
} satisfies Section<typeof en>;
