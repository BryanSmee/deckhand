// French texts of Settings › Repositories (Repos.tsx) and the server's health (Health.tsx): spread into the French catalog (fr.ts).
import type { Section } from ".";
import type { repos as en } from "./en-repos";

export const repos = {
  // Settings › Repositories: a config that isn't the user's to read
  "repos.configLabel": "Configuration de {repo}",
  "repos.configDenied":
    "La config de {repo} ne vous est pas lisible : vous n’y avez pas {permission}.",
  "repos.back": "Retour aux dépôts",

  // The onboarding card
  "repos.notOnboarded": {
    one: "{count} dépôt sans onboarding",
    other: "{count} dépôts sans onboarding",
  },
  "repos.onboardingIntro":
    "L’onboarding écrit son {file} avec vous. D’ici là, rien ne s’y exécute.",
  "repos.starting": "Démarrage…",
  "repos.onboard": "Lancer l’onboarding de {repo}",
  "repos.onboardFailed": "Onboarding de {repo} impossible : {error}",
  "repos.steps": "Étapes de l’onboarding",
  "repos.stepStart": "Lancer l’onboarding",
  "repos.stepStartHelp": "Deckhand ouvre une issue dans le dépôt et y lance une exécution.",
  "repos.stepAnswer": "Répondre à ses questions",
  "repos.stepAnswerHelp":
    "L’exécution lit le code, puis demande ce qu’elle ne peut pas deviner : préparation, tests, modes.",
  "repos.stepMerge": "Fusionner sa pull request",
  "repos.stepMergeHelp":
    "La config arrive sur la branche par défaut ; les issues peuvent démarrer aussitôt.",

  // The list and its toolbar
  "repos.title": "Dépôts",
  "repos.filter": "Filtrer les dépôts",
  "repos.show": "Afficher",
  "repos.showAll": "Tous",
  "repos.showNeeds": "À traiter",
  "repos.showConfigured": "Configurés",
  "repos.listed": "Listés {ago}",
  "repos.refresh": "Actualiser",
  "repos.refreshHelp": "Lister les dépôts des installations et relire chaque config",
  "repos.manage": "Gérer l’App",
  "repos.manageHelp": "Ajouter ou retirer des dépôts sur GitHub ({app})",
  "repos.refreshFailed": "Actualisation impossible ({error})",
  "repos.listFailed": "Impossible de lister les dépôts ({error}).",
  "repos.loading": "Chargement…",
  "repos.noneInstalled": "L’App n’est encore installée sur aucun dépôt autorisé.",
  "repos.install": "Installer l’App sur un dépôt",
  "repos.noneHere": "Aucun dépôt ici.",
  "repos.noneMatch": "Aucun dépôt ici ne correspond au filtre.",

  // A repository's row: its detail and action
  "repos.invalid":
    "Son .deckhand.yaml contient des erreurs : aucune exécution ne démarre tant qu’elles ne sont pas corrigées",
  "repos.openConfig": "Ouvrir la config",
  "repos.config": "Config",
  "repos.questionsWaiting": {
    one: "{count} question attend vos réponses",
    other: "{count} questions attendent vos réponses",
  },
  "repos.questionsWaitingAll": "Ses questions attendent vos réponses",
  "repos.runFailed": "Son exécution a échoué : ouvrez-la pour la relancer",
  "repos.runInterrupted": "Son exécution a été interrompue : ouvrez-la pour la relancer",
  "repos.runStopped": "Son exécution a été arrêtée : ouvrez-la pour la relancer",
  "repos.runNoPr": "Son exécution s’est terminée sans pull request : ouvrez-la pour la relancer",
  "repos.prOpen": "Sa pull request est ouverte : fusionnez-la pour terminer",
  "repos.runReads": "Son exécution lit le code et propose une config",
  "repos.runWaits": "Son exécution attend un emplacement libre",
  "repos.runReports": "Son exécution rend compte sur l’issue",
  "repos.issueState": "Issue #{number} · {state}",
  "repos.issueHelp": "L’issue d’onboarding sur GitHub",
  "repos.answer": "Répondre",
  "repos.openRun": "Ouvrir l’exécution",
  "repos.noConfig": "Pas de .deckhand.yaml sur sa branche par défaut",
  "repos.startOnboarding": "Lancer l’onboarding",
  "repos.issuesOff": "Ses issues sont désactivées sur GitHub : l’onboarding est donc impossible",
  "repos.issuesOffHelp": "Ses paramètres sur GitHub : Features › Issues",
  "repos.enableIssues": "Activer les issues",
  "repos.unknown": "GitHub n’a pas répondu : voir les journaux de l’orchestrateur",
  "repos.configured": "Configuré",
  "repos.read": "Lue {ago}",
  "repos.its": "{repo} : sa config",
  "repos.private": "privé",
  "repos.autoMerge": "Fusion auto, sans revue humaine",
  "repos.autoMergeHelp":
    "Deckhand fusionne ses propres pull requests après sa revue : personne ne les lit avant qu’elles n’atteignent la branche par défaut",

  // The footer: which Deckhand runs
  "repos.version": "Deckhand {version} · {uptime} · Node {node}",
  "repos.up": "actif depuis {time}",
  "repos.since": "Depuis le {date}",

  // The services' health (Settings › Server, and the shell's alert)
  "health.up": "Actif",
  "health.starting": "Démarrage",
  "health.down": "En panne",
  "health.notChecked": "Non vérifié",
  "health.roleEdge": "webhooks, API, interface",
  "health.roleOrchestrator": "événements, tâches, file d’attente",
  "health.roleRunner": "sandboxes, images, journaux",
  "health.roleBroker": "jetons, endpoints des exécutions",
  "health.roleGithub": "passerelles GitHub",
  "health.roleModels": "relais de l’API des agents",
  "health.rolePolicy": "opa, sans réseau",
  "health.roleProxy": "la sortie des exécutions",
  "health.unreachable": "injoignable : {reason}",
  "health.noAnswer": "pas de réponse",
  "health.isUp": "actif",
  "health.isStarting": "en démarrage",
  "health.startedAgo": "démarré {ago}",
  "health.upFor": "actif depuis {time}",
  "health.alertDown": "{services} en panne",
  "health.alertStarting": "{services} en démarrage",
  "health.manyDown": { one: "{count} service en panne", other: "{count} services en panne" },
  "health.manyStarting": {
    one: "{count} service en démarrage",
    other: "{count} services en démarrage",
  },
  "health.alertLabel": "{alert} : voir l’état des services",

  // The diagram
  "health.outsideWeb": "webhooks GitHub",
  "health.outsideWebRole": "et navigateurs",
  "health.outsideAi": "API des agents",
  "health.outsideHosts": "hôtes autorisés",
  "health.outsideSandbox": "sandboxes",
  "health.outsideSandboxRole": "non vérifiées",
  "health.arrowDeliveries": "livraisons, App",
  "health.arrowFirstTokens": "premiers jetons d’une exécution",
  "health.arrowTarballs": "archives",
  "health.arrowStarts": "démarrages",
  "health.arrowEgress": "politique de sortie",
  "health.arrowGrants": "autorisations",
  "health.arrowRefresh": "rafraîchissement",
  "health.andBack": "et retour : {what}",
  "health.nodeNotChecked": "non vérifié",
  "health.serviceTitle": "{name} : {role}",
  "health.serviceTitleVersion": "{name} : {role} · {version}",
  "health.serviceState": "{name} {state}",
  "health.diagram": "Les services : {summary}",
  "health.notCheckedYet": "Pas encore vérifiés",
  "health.notCheckedYetList": "Pas encore vérifiés.",

  // The card
  "health.services": "Services",
  "health.checkFailed": "Vérification impossible ({error})",
  "health.checkedAt": "Vérifiés à {time} · toutes les 15 s",
  "health.checking": "Vérification…",
  "health.warnings": "Avertissements",
  "health.legend": "Légende",

  // A repository's status, as its badge says it (RepoBadge.tsx)
  "repoStatus.configured": "Configuré",
  "repoStatus.invalid": "Config en erreur",
  "repoStatus.onboarding": "Onboarding",
  "repoStatus.notOnboarded": "Sans onboarding",
  "repoStatus.unknown": "Inconnu",
} satisfies Section<typeof en>;
