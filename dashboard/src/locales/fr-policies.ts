// French texts of Settings › a repository's policies (Policies.tsx, PolicyConfig.tsx) and Server (Server.tsx): spread into the French catalog (fr.ts).
import type { Section } from ".";
import type { policies as en } from "./en-policies";

export const policies = {
  // A task's Policies tab: each decision's name
  "policies.run": "Exécution refusée",
  "policies.merge": "Fusion auto",
  "policies.review": "Revue automatique",
  "policies.fix": "Exécution de correction",
  "policies.linkBranch": "Branche liée",
  "policies.requestReview": "Relecteurs demandés",

  // A task's Policies tab: the decisions, newest first
  "policies.decisions": "Décisions des politiques, les plus récentes d’abord",
  "policies.kept":
    "Les {kept} dernières décisions sont conservées par tâche, pendant {days} jours.",
  "policies.error": "Erreur de politique",
  "policies.denied": "Refusée",
  "policies.allowed": "Autorisée",
  "policies.ofPr": "de #{pr}",
  "policies.reasons": { one: "{count} raison", other: "{count} raisons" },
  "policies.failClosed": "{error} : refusée, toute erreur vaut refus",
  "policies.reasonsList": "Raisons",
  "policies.noDenial": "Aucune règle ne l’a refusée.",
  "policies.layers": "Ce qu’a dit chaque couche",
  "policies.gatesFirst": "D’abord les contrôles intégrés :",
  "policies.input": "L’entrée vue par les règles",
  "policies.cut": "tronquée",
  "policies.tooBig": "Trop volumineuse pour être conservée, même tronquée.",

  // A task's Policies tab: what each layer said
  "policies.operator": "Opérateur",
  "policies.repo": "Dépôt",
  "policies.notAsked": "non consultée : pas un des modes du dépôt",
  "policies.matched": "correspond",
  "policies.noMatch": "aucune règle ne correspond",
  "policies.nothing": "rien",
  "policies.inFiles": "{said} ({files})",

  // A task's Policies tab: a merge a policy kept for a human
  "policies.held": "Une politique a réservé cette pull request à un humain",
  "policies.heldGates": "Contrôles de Deckhand franchis {at}, puis {then}",
  "policies.heldAt": "{at} : {then}",
  "policies.heldFailed": "{rule} a échoué, d’où un refus : toute erreur de politique vaut refus.",
  "policies.heldReturned": {
    one: "{rule} a renvoyé {count} raison.",
    other: "{rule} a renvoyé {count} raisons.",
  },
  "policies.mergeOnGithub": "Fusionner sur GitHub ↗",

  // A task's Policies tab: the side cards
  "policies.side": "Politiques",
  "policies.dryRun": "Essai à blanc",
  "policies.dryRunHelp":
    "Commentez {command} sur la pull request pour vérifier chaque règle sur son état actuel. Rien n’est relu, corrigé ni fusionné.",
  "policies.lastBy": "Dernier : par @{by} {at} · {denials}",
  "policies.last": "Dernier : {at} · {denials}",
  "policies.denials": { one: "{count} refus", other: "{count} refus" },
  "policies.reply": "sa réponse ↗",
  "policies.noDryRun": "Aucun pour l’instant sur cette pull request.",
  "policies.rules": "Les règles",
  "policies.rulesHelp": "Les fichiers de politique qui s’appliquent à {repo}, et leurs erreurs.",
  "policies.repoPolicies": "Politiques de {repo} →",

  // A repository's Policies tab: the header's badge while the check fails
  "policyConfig.trouble": "Erreur de politique",
  "policyConfig.troubleFiles": {
    one: "{count} politique ne compile pas",
    other: "{count} politiques ne compilent pas",
  },

  // A repository's Policies tab: none at all
  "policyConfig.none": "Aucune politique : seuls les contrôles intégrés décident.",
  "policyConfig.noneHelp":
    "Un dépôt en ajoute dans {files} sur {base}, l’opérateur dans son dossier d’autorisations.",

  // A repository's Policies tab: the banner while the check fails
  "policyConfig.fileFails":
    "{file} ne compile pas : toute décision demandée à une politique est refusée",
  "policyConfig.cantCheck":
    "Les politiques ne peuvent pas être vérifiées : toute décision demandée à une politique est refusée",
  "policyConfig.errors": {
    one: "{count} erreur de politique : toute décision demandée à une politique est refusée",
    other: "{count} erreurs de politique : toute décision demandée à une politique est refusée",
  },
  "policyConfig.failClosed": {
    one: "Une erreur de politique vaut refus, et les fichiers de chaque couche sont vérifiés ensemble. Tant qu’elle n’est pas corrigée, les fusions auto, revues automatiques, exécutions de correction et écritures des exécutions sur GitHub sont toutes refusées ici avec « erreur de politique ». Les exécutions lancées par un commentaire démarrent quand même.",
    other:
      "Une erreur de politique vaut refus, et les fichiers de chaque couche sont vérifiés ensemble. Tant qu’elles ne sont pas corrigées, les fusions auto, revues automatiques, exécutions de correction et écritures des exécutions sur GitHub sont toutes refusées ici avec « erreur de politique ». Les exécutions lancées par un commentaire démarrent quand même.",
  },
  "policyConfig.lineLink": "Ligne {row} ↓",
  "policyConfig.line": "ligne {row} ↓",

  // A repository's Policies tab: warnings, and how policies work
  "policyConfig.warnings": "Avertissements des politiques",
  "policyConfig.ignored": "Ignoré",
  "policyConfig.warning": "Avertissement",
  "policyConfig.model":
    "Après les contrôles de Deckhand, une décision est autorisée quand une règle {allow} correspond et qu’aucune règle {deny} ne correspond : un refus l’emporte toujours. Les fichiers de Deckhand et de l’opérateur forment une seule couche, ceux de l’opérateur remplaçant ceux de Deckhand de même nom : leurs règles d’autorisation sont le plafond. Les fichiers du dépôt, lus depuis {base}, sont évalués à part : leurs règles de refus s’appliquent à toute exécution, leurs règles d’autorisation seulement aux {modes} propres du dépôt, qui exigent aussi l’autorisation de l’opérateur.",
  "policyConfig.githubInput":
    "{allow_github} et {deny_github} lisent l’écriture ({action}, {target}, {change}), ou une lecture des checks de la CI ou des projets ({action} {read_checks}, {read_projects}, sans {target} ni {change}), et l’exécution : son {mode}, {custom_mode} (un des {modes} du dépôt) et {reason} ({review_fix}, {ci_fix}, {conflict} ou null).",
  "policyConfig.githubInputLink": "L’entrée GitHub",
  "policyConfig.pushInput":
    "{allow_push} et {deny_push} lisent chaque branche qu’une exécution pousse, après les contrôles propres de la passerelle git : les champs de l’exécution, la {branch}, si le push l’a {created} ou {deleted}, et la {default_branch}.",
  "policyConfig.pushInputLink": "L’entrée push",
  "policyConfig.runInput":
    "{allow_run} et {deny_run} lisent l’exécution qu’une personne demande, avant sa mise en file : son {mode}, {custom_mode}, {trigger} ({comment}, {dashboard}, {inbox}, {discussion}), {sender} et le {target} que vise son commentaire ({kind}, {labels}, {author}).",
  "policyConfig.runInputLink": "L’entrée d’exécution",

  // A repository's Policies tab: a card per decision, its name, what a denial does, and what
  // refuses it while the check fails or no allow rule matches ({until})
  "policyConfig.decisions": "Décisions",
  "policyConfig.decisionRun": "Exécutions lancées par une personne",
  "policyConfig.deniesRun":
    "Un refus ne lance aucune exécution (un commentaire déclencheur, /mode, un commentaire qui continue dans un mode, le tableau de bord, une entrée de la boîte de réception, une discussion) : la réponse cite les messages.",
  "policyConfig.refusedRun": "Aucune exécution demandée par une personne ne démarre {until}.",
  "policyConfig.allowsRunOwn":
    "Ses règles d’autorisation décident où chaque mode s’exécute : le run.rego de Deckhand limite les brainstorms, /stop et l’onboarding aux issues (un commentaire qui continue dans un mode n’est pas refusé).",
  "policyConfig.allowsRun": "Ses règles d’autorisation décident où chaque mode s’exécute.",
  "policyConfig.decisionMerge": "Fusion auto",
  "policyConfig.deniesMerge":
    "Un refus réserve la pull request à un humain : elle n’est pas fusionnée.",
  "policyConfig.refusedMerge": "Toute fusion auto est refusée {until}.",
  "policyConfig.decisionReview": "Revue automatique",
  "policyConfig.deniesReview":
    "Un refus annule la revue automatique ; /mode review s’exécute quand même.",
  "policyConfig.refusedReview":
    "Les revues automatiques n’ont pas lieu {until} ; /mode review s’exécute quand même.",
  "policyConfig.decisionFix": "Exécution de correction",
  "policyConfig.deniesFix":
    "Un refus ne lance aucune exécution de correction (celle d’une revue, une correction CI ou le rebase d’un conflit) ; un commentaire sur la pull request explique pourquoi.",
  "policyConfig.refusedFix": "Toute exécution de correction est refusée {until}.",
  "policyConfig.decisionLinkBranch": "Branche liée",
  "policyConfig.deniesLinkBranch":
    "Un refus ne lie aucune branche à l’issue au démarrage d’une exécution work ; l’exécution crée sa branche elle-même.",
  "policyConfig.refusedLinkBranch": "Aucune branche n’est liée à une issue {until}.",
  "policyConfig.decisionRequestReview": "Relecteurs",
  "policyConfig.deniesRequestReview":
    "Un refus ne demande aucun relecteur (review.request) sur la pull request de Deckhand ; le journal du listener explique pourquoi.",
  "policyConfig.refusedRequestReview": "Aucun relecteur n’est demandé {until}.",
  "policyConfig.decisionGithub": "Écritures et checks GitHub",
  "policyConfig.deniesGithub":
    "Un refus rejette l’écriture d’une exécution sur GitHub (REST ou GraphQL), ou ses lectures des checks de la CI (read_checks, comme en font gh pr checks et gh pr view) et des projets (read_projects) ; gh affiche les messages à l’agent.",
  "policyConfig.refusedGithub":
    "Toute écriture d’une exécution sur GitHub, et toute lecture des checks de la CI et des projets, est refusée {until}.",
  "policyConfig.allowsGithub":
    "Ses règles d’autorisation décident de ce que chaque mode écrit : les mode-<mode>.rego de Deckhand, un fichier par mode.",
  "policyConfig.decisionPush": "Pushs",
  "policyConfig.deniesPush":
    "Un refus rejette le push d’une branche par une exécution (le push entier) : git affiche les messages pour chaque ref.",
  "policyConfig.refusedPush": "Tout push d’une exécution est refusé {until}.",
  "policyConfig.allowsPush":
    "Ses règles d’autorisation décident quels modes poussent : le mode-work.rego de Deckhand, les exécutions work et les modes propres du dépôt (avec aussi l’autorisation du dépôt).",
  "policyConfig.untilChecked": "tant que les politiques ne peuvent pas être vérifiées",
  "policyConfig.untilCompiles": {
    one: "tant que {files} ne compile pas",
    other: "tant que {files} ne compilent pas",
  },
  "policyConfig.untilAllowed":
    "tant qu’aucune règle d’autorisation de l’opérateur ne lui correspond",
  "policyConfig.nothingDenies": "Rien ne la refuse : seuls les contrôles de Deckhand décident.",

  // A repository's Policies tab: a decision card's state and each layer's rules
  "policyConfig.refused": "Refusée",
  "policyConfig.neverAllowed": "Jamais autorisée",
  "policyConfig.active": "Active",
  "policyConfig.noDenyRule": "Aucune règle de refus",
  "policyConfig.noRule": "pas de {rule}",
  "policyConfig.noAllowRule": "pas de règle d’autorisation",
  "policyConfig.repoAllowIgnored": "{said} : ignorée, aucun mode du dépôt ne la demande",
  "policyConfig.repoAllowOwn": "{said}, pour ses propres modes",
  "policyConfig.operatorRules": "Opérateur : {allow} · {deny}",
  "policyConfig.repoRules": "Dépôt : {allow} · {deny}",

  // A repository's Policies tab: the policy files' table
  "policyConfig.files": "Fichiers de politique",
  "policyConfig.filesNote": {
    one: "{count} fichier · {counts} · ceux de Deckhand et de l’opérateur fusionnés par nom, ceux du dépôt à part",
    other:
      "{count} fichiers · {counts} · ceux de Deckhand et de l’opérateur fusionnés par nom, ceux du dépôt à part",
  },
  "policyConfig.fromDeckhand": "{count} de Deckhand",
  "policyConfig.fromOperator": "{count} de l’opérateur",
  "policyConfig.fromRepo": "{count} du dépôt",
  "policyConfig.columnFile": "Fichier",
  "policyConfig.columnFrom": "Origine",
  "policyConfig.columnEffect": "Effet",
  "policyConfig.columnRules": "Règles",
  "policyConfig.columnCompiles": "Compile",
  "policyConfig.tagDeckhand": "deckhand",
  "policyConfig.tagOperator": "opérateur",
  "policyConfig.tagRepo": "dépôt",
  "policyConfig.ownerDeckhand": "celui de Deckhand",
  "policyConfig.ownerOperator": "celui de l’opérateur",
  "policyConfig.ownerRepo": "celui du dépôt",
  "policyConfig.replacedBy": "Remplacé par {owner}",
  "policyConfig.replaces": "Remplace {owner}",
  "policyConfig.added": "Ajouté",
  "policyConfig.kept": "Par défaut, conservé",
  "policyConfig.noRules": "aucune règle",
  "policyConfig.compilesError": "Erreur",
  "policyConfig.compilesUnknown": "Inconnu",
  "policyConfig.compilesYes": "Oui",

  // A repository's Policies tab: a file's source, folded
  "policyConfig.sourceReplaces": "remplace {owner} ({name})",
  "policyConfig.sourceReplacedBy": "remplacé par {owner} : non évalué",
  "policyConfig.lines": { one: "{count} ligne", other: "{count} lignes" },
  "policyConfig.truncated": "ses 20 premiers Ko",
  "policyConfig.sourceErrors": { one: "{count} erreur", other: "{count} erreurs" },
  "policyConfig.edit": "Modifier sur GitHub",

  // A repository's Policies tab: trying them on a pull request
  "policyConfig.try": "Les essayer sur une pull request",
  "policyConfig.tryHelp":
    "Commentez {command} dessus : Deckhand répond avec le résultat de chaque décision, ce qu’ont dit les règles de chaque couche, et l’entrée qu’elles ont vue. Rien n’est relu, corrigé ni fusionné.",
  "policyConfig.copy": "Copier la commande",
  "policyConfig.copied": "Copiée",
  "policyConfig.copyFailed": "Copie impossible",

  // Settings › Server: the listener's status
  "server.unreachable": "Listener injoignable",
  "server.up": "Le listener est actif",
  "server.loading": "Chargement…",
  "server.version": "Deckhand {version} · actif depuis {uptime}, démarré {since} · Node {node}",
  "server.versionFrom":
    "Deckhand {version} · actif depuis {uptime}, démarré {since} · Node {node} · construit depuis {repo}",
  "server.operatorNote":
    "Son opérateur les modifie dans l’environnement du serveur et le dossier d’autorisations.",

  // Settings › Server: runs, the engine, the proxy and the grants folder
  "server.runs": "Exécutions",
  "server.slots": "Emplacements",
  "server.running": "{count} en cours",
  "server.plans": "Forfaits",
  "server.engine": "Moteur de conteneurs",
  "server.engineSysbox": "Sysbox",
  "server.enginePodman": "Podman",
  "server.engineAuto": "Sysbox, sinon Podman",
  "server.engineNone": "Aucun",
  "server.noCredential": "Aucun identifiant défini",
  "server.credentialFallback": "{label} d’abord, puis {fallbacks} en secours",
  "server.credentialsAlso": "{names} aussi définis",
  "server.unread": "Lecture impossible ({error})",
  "server.proxy": "Proxy de sortie",
  "server.proxyOn": "Activé",
  "server.proxyOff": "Désactivé",
  "server.hostsUncounted": "hôtes non comptés",
  "server.hosts": { one: "{count} hôte autorisé", other: "{count} hôtes autorisés" },
  "server.grants": "Dossier d’autorisations",
  "server.grantsOk": "Lu, sans erreur",
  "server.grantsErrorsIn": "Erreurs dans {file}",
  "server.grantsErrors": "Erreurs",

  // Settings › Server: the GitHub App
  "server.app": "GitHub App",
  "server.appSettings": "Paramètres de l’App",
  "server.appSettingsLink": "Paramètres de l’App ↗",
  "server.install": "Installer sur un autre compte",
  "server.name": "Nom",
  "server.installedOn": "Installée sur",
  "server.noAccount": "Aucun compte pour l’instant",
  "server.anAccount": "Un compte",
  "server.lacks": "il manque {missing}",
  "server.acceptPermissions": "accepter les nouvelles permissions ↗",
  "server.configure": "configurer ↗",
  "server.missing": "Manquant dans ses paramètres",
  "server.missingPermissions": {
    one: "{count} permission : {names}",
    other: "{count} permissions : {names}",
  },
  "server.addPermissions": {
    one: "ajoutez-la sous Permissions, puis acceptez-la sur chaque installation",
    other: "ajoutez-les sous Permissions, puis acceptez-les sur chaque installation",
  },
  "server.missingEvents": {
    one: "{count} événement : {names}",
    other: "{count} événements : {names}",
  },
  "server.addEvents": {
    one: "activez-le sous Subscribe to events",
    other: "activez-les sous Subscribe to events",
  },
  "server.users": "Qui peut se connecter",
  "server.repos": "Dépôts autorisés",
  "server.everyRepo": "Tous les dépôts où l’App est installée",

  // Settings › Server: the webhook deliveries and the last sync
  "server.deliveries": "Livraisons de webhooks",
  "server.noSync": "Aucune synchro pour l’instant.",
  "server.syncFailed": "Échec de la dernière synchro {when} : {error}",
  "server.syncUpToDate": "Dernière synchro {when} : à jour avec GitHub.",
  "server.synced": "Dernière synchro {when} : {done}.",
  "server.sync": "Synchroniser",
  "server.syncing": "Synchronisation…",
  "server.syncHelp":
    "Redemander à GitHub les livraisons de webhooks qu’il n’a pas pu remettre, l’état des pull requests ouvertes, et si elles fusionnent encore",

  // A run's Claude credential (format.ts AUTH_NAMES)
  "auth.plan": "Forfait",
  "auth.key": "Clé d’API",
  "auth.gateway": "Passerelle",

  // How long a service has been up (format.ts uptime())
  "time.upMinutes": "{min} min",
  "time.upHours": "{h} h {min} min",
  "time.upDays": "{d} j {h} h",
} satisfies Section<typeof en>;
