// French texts of Settings › Repositories › a repository's configuration (ConfigPanel.tsx, Capabilities.tsx), MCP clients (Clients.tsx) and Access (Access.tsx): spread into the French catalog (fr.ts).
import type { Section } from ".";
import type { config as en } from "./en-config";

export const config = {
  // A repository's configuration: its header and tabs
  "config.breadcrumb": "Fil d’Ariane",
  "config.crumbSettings": "Paramètres",
  "config.crumbRepositories": "Dépôts",
  "config.readFile": "{file} sur {base} · blob {sha} · lu {when}",
  "config.readNoFile": "Pas de {file} sur {base} · lu {when}",
  "config.reading": "Lecture…",
  "config.readAgain": "Relire",
  "config.readAgainHelp": "Relire sa config depuis GitHub",
  "config.editOnGithub": "Modifier sur GitHub",
  "config.tabs": "Paramètres du dépôt",
  "config.tabConfig": "Config",
  "config.tabPolicies": "Politiques",
  "config.tabCapabilities": "Capacités",
  "config.unreadable": "Lecture impossible ({error}).",
  "config.readingGithub": "Lecture depuis GitHub…",

  // Its sources' tags and filters
  "config.tagRepo": "du dépôt",
  "config.tagOperator": "de l’opérateur",
  "config.tagRefused": "refusé",
  "config.tagUnknown": "inconnu",
  "config.filterAll": "Tout",
  "config.filterRepo": "Du dépôt",
  "config.filterOperator": "De l’opérateur",
  "config.filterRefused": "Refusés",
  "config.filterUnknown": "Inconnus",

  // What stops its runs
  "config.problemsTitle": "Aucune exécution ne démarre tant que ceci n’est pas corrigé",
  "config.ungranted":
    "Seul l’opérateur l’accorde, avec une règle {allowGrant} dans le sous-dossier {policy} de son dossier d’autorisations ; d’ici là, retirez-le de {file}.",
  "config.grantsFileErrorAny":
    "{file} dans le dossier d’autorisations de l’opérateur contient des erreurs, donc aucune exécution ne démarre, dans aucun dépôt : {error}",
  "config.grantsFileErrorThis":
    "{file} dans le dossier d’autorisations de l’opérateur contient des erreurs, donc aucune exécution ne démarre dans ce dépôt : {error}",
  "config.grantsErrorAny":
    "Le dossier d’autorisations de l’opérateur contient des erreurs, donc aucune exécution ne démarre, dans aucun dépôt : {error}",
  "config.grantsErrorThis":
    "Le dossier d’autorisations de l’opérateur contient des erreurs, donc aucune exécution ne démarre dans ce dépôt : {error}",
  "config.grantsFix": "Seul l’opérateur peut corriger cela, dans son dossier d’autorisations.",
  "config.settingRefused": "refusé : {note}",
  "config.needsGrant": "il faut une autorisation",
  "config.mountRefused": "{path} refusé : {note}",
  "config.line": "ligne {line}",
  "config.warning": "Avertissement",
  "config.warnings": "Avertissements",
  "config.noFile":
    "Pas de {file} : ses exécutions reçoivent les valeurs par défaut de l’opérateur, toutes celles ci-dessous.",

  // A fine config
  "config.fineTitle": "Tout va bien : les exécutions démarrent ici",
  "config.fineText":
    "Aucune erreur, aucun avertissement, rien de refusé par les autorisations de l’opérateur.",
  "config.glance": "En bref",
  "config.glanceModel": "S’exécute avec",
  "config.glanceEffort": "effort {effort}",
  "config.glanceParallel": "En parallèle",
  "config.glanceUsers": "Qui peut déclencher",
  "config.glanceAccess": "Hôtes · montages",
  "config.none": "aucun",

  // What its runs get, hosts, mounts and the grant
  "config.runsGet": "Ce que reçoivent ses exécutions",
  "config.runsMeta": {
    one: "{count} paramètre · {own} du dépôt",
    other: "{count} paramètres · {own} du dépôt",
  },
  "config.showMore": "Afficher les {count} autres, de l’opérateur",
  "config.show": "Afficher",
  "config.noRows": "Aucun.",
  "config.narrowOnly":
    "La config d’un dépôt peut seulement restreindre ce que l’opérateur permet. Ce qui l’élargirait est une autorisation dans le dossier d’autorisations de l’opérateur.",
  "config.settingsList": "Paramètres",
  "config.accessFold": "Hôtes, montages et autorisation de l’opérateur",
  "config.hostsCount": { one: "{count} hôte", other: "{count} hôtes" },
  "config.mountsCount": { one: "{count} montage", other: "{count} montages" },
  "config.noMounts": "aucun montage",
  "config.researchOn": "recherche activée",
  "config.hostsTitle": "Hôtes que ses sandboxes peuvent joindre",
  "config.hostsList": "Hôtes",
  "config.mounts": "Montages de l’hôte",
  "config.readOnly": "lecture seule",
  "config.readWrite": "lecture-écriture",
  "config.grant": "L’autorisation de l’opérateur",
  "config.grantUnknown": "Inconnue : les autorisations de l’opérateur contiennent des erreurs.",
  "config.grantNoPolicy": "aucune : pas de règle allow_grant, rien d’accordé",
  "config.grantNoFile": "aucune : rien au-delà de ce que reçoit tout dépôt",
  "config.grantRootReadOnly": "{root} (lecture seule)",
  "config.grantLimits": "{cpus} CPU · {memory} de mémoire · {pids} processus",
  "config.grantSwitches": "Options",
  "config.grantLists": "Listes",
  "config.on": "oui",
  "config.off": "non",

  // The file, the page's links
  "config.yamlLines": { one: "{count} ligne", other: "{count} lignes" },
  "config.yamlErrors": { one: "{count} erreur", other: "{count} erreurs" },
  "config.copy": "Copier",
  "config.copied": "Copié",
  "config.copyFailed": "Copie impossible",
  "config.onThisPage": "Sur cette page",
  "config.tocProblems": "Problèmes",
  "config.tocHosts": "Hôtes",
  "config.changing": "La modifier",
  "config.changingHelp":
    "Un commit modifiant {file} sur {base}. Deckhand la relit au push, ou avec « Relire ».",

  // Auto-merge's warning
  "config.autoMergeTitle": "Fusion automatique : aucune revue humaine",
  "config.autoMergeText":
    "Ici, Deckhand fusionne ses propres pull requests une fois que sa revue (et son exécution de correction) ne trouve rien de bloquant. La sortie du modèle atteint la branche par défaut sans que personne ne la lise : une injection de prompt dans une issue ou un commentaire, ou une mauvaise correction, part en production, et lance les workflows du dépôt sur la branche par défaut avec ses secrets.",
  "config.autoMergePublic":
    "{lead} n’importe qui peut commenter, donc n’importe qui peut tenter d’orienter ce qui est fusionné.",
  "config.autoMergePublicLead": "Ce dépôt est public :",
  "config.autoMergeDocs": "Ce à quoi elle renonce, et ses garde-fous",

  // The policies' files and rules, as Capabilities and Access name them
  "config.ruleOfRepo": "une règle du dépôt",
  "config.ruleOfOperator": "une règle de l’opérateur",
  "config.repoFile": "dépôt : {file}",
  "config.allowRule": "allow",
  "config.denyRule": "deny",
  "config.allowedBy": "Autorisé par {files}",
  "config.decidedBy": "Décidé par {files}",

  // Capabilities
  "config.capabilityUsed": "Utilisée",
  "config.capabilityDenied": "Refusée",
  "config.capabilityNotAllowed": "Non autorisée",
  "config.capabilityNotAsked": "Non demandée",
  "config.capabilityNotGranted": "Non accordée",
  "config.capabilitiesPolicyError": "Capacités : erreur de politique",
  "config.modesStopped": {
    one: "{count} mode ne peut pas s’exécuter",
    other: "{count} modes ne peuvent pas s’exécuter",
  },
  "config.capabilitiesUndecided":
    "Les politiques ne peuvent pas décider ce que reçoivent les exécutions : aucune ne démarre",
  "config.capabilitiesModel":
    "À son démarrage, une exécution reçoit chaque capacité qu’une règle {allow} des politiques lui donne ({allowCapabilities}) et qu’aucune règle {deny} ne refuse ({denyCapabilities}), à condition que {file} la demande si une clé la contrôle, et que l’autorisation de l’opérateur la donne si elle en dépend. En dehors de celles-ci, toute exécution a sa sandbox, l’API de l’agent et son prompt, rien du dépôt. Affiché pour une exécution lancée par un commentaire sur une issue, hors fork : une politique peut décider autrement pour une pull request, celle d’un fork ou une exécution de correction.",
  "config.capabilitiesDocs": "Fonctionnement des capacités",
  "config.capabilitiesModes": "Ce que reçoivent les exécutions de chaque mode",
  "config.capabilitiesModesNote": {
    one: "{count} mode · lu depuis {base}",
    other: "{count} modes · lus depuis {base}",
  },
  "config.modeStopped": "Ne démarre pas",
  "config.modeWarned": "Démarre, avec avertissements",
  "config.modeStarts": "Démarre",
  "config.modeLabel": "Le mode {mode}",
  "config.modeCustom": "propre au dépôt",
  "config.modeCapabilities": "Ses capacités",
  "config.modeNothing": "Rien du dépôt",
  "config.modeErrors": "Ce qui bloque ses exécutions",
  "config.modeEvery": "Toutes les capacités",
  "config.catalogueTitle": "Les capacités",
  "config.catalogueNote":
    "Une exécution dont une capacité n’a pas celles dont elle dépend ne démarre pas ; ni une exécution avec {pull} d’un dépôt privé et {internet}, sauf si les politiques de l’opérateur donnent {both}.",
  "config.catalogueCapability": "Capacité",
  "config.catalogueGives": "Donne",
  "config.catalogueNeeds": "Nécessite",
  "config.catalogueAsked": "Demandée par",
  "config.catalogueEnforced": "Appliquée par",
  "config.catalogueList": "Le catalogue",
  "config.catalogueOr": " ou ",
  "config.cataloguePoliciesAlone": "les politiques seules",
  "config.catalogueGrant": " · autorisation {grant}",

  // MCP clients
  "config.scopeRead": "Lecture",
  "config.scopeWork": "Travail",
  "config.scopeMachine": "Machine",
  "config.clientsNote":
    "Un client MCP se connecte à {url}, vous connecte avec GitHub et vous demande de l’autoriser. Il agit en votre nom, avec vos droits sur ce tableau de bord. Vous déconnecter les déconnecte tous aussi.",
  "config.clientsThisMcp": "le /mcp de ce Deckhand",
  "config.clientsTitle": "Connectés en votre nom",
  "config.clientsUnreadable": "Impossible de lire les clients : {error}",
  "config.clientsNone": "Aucun client MCP n’est connecté en votre nom.",
  "config.clientsReading": "Lecture…",
  "config.clientConnected": "Connecté {connected} · {scopes}",
  "config.clientUsed": "Connecté {connected} · dernière utilisation {used} · {scopes}",
  "config.clientRedirect": "Là où il a été renvoyé après votre autorisation",
  "config.revoke": "Révoquer",
  "config.revokeClient": "Révoquer {name}",

  // Access
  "config.actionAll": "toutes les actions",
  "config.actionTasksRead": "voit ses tâches et exécutions",
  "config.actionLogsRead": "lit les journaux de ses exécutions",
  "config.actionRunsManage": "arrête, relance, répond, écarte, ordonne et nomme les colonnes",
  "config.actionStartAll": "lance des exécutions dans tous les modes",
  "config.actionStart": "lance des exécutions en mode {mode}",
  "config.actionStartPrefix": "lance des exécutions dans les modes commençant par {prefix}",
  "config.actionConfigRead": "lit sa config et fait son onboarding",
  "config.actionServerRead": "lit Paramètres › Serveur et Accès, la santé et les forfaits",
  "config.actionServerSync": "synchronise avec GitHub",
  "config.actionServerAll": "toutes les actions sur le serveur",
  "config.accessModel":
    "Qui peut faire quoi, ce sont les politiques de l’opérateur qui le disent : un login a une action quand une de leurs règles {allow} la lui donne ({allowAccess}, les {bindings} d’un rôle) et qu’aucune règle {deny} ne la lui retire ({denyAccess}, celle de l’opérateur ou du {repoPolicy} du dépôt), dans la limite de {allowedUsers} et des {users} du dépôt. Un dépôt sans aucune action est caché à ce login. Lecture seule : c’est le {accessRego} du dossier d’autorisations qui le modifie.",
  "config.accessDocs": "Fonctionnement des accès",
  "config.accessUnreadable": "Impossible de lire qui a quoi ({error}).",
  "config.accessServerOnly": "Seulement les actions sur le serveur : {error}.",
  "config.accessFilter": "Filtrer par login ou dépôt",
  "config.accessLoading": "Chargement…",
  "config.accessNoMatch": "Aucun login ni dépôt ne correspond.",
  "config.accessNoLogin": "Aucun login.",
  "config.accessRepos": {
    one: "{count} dépôt avec accès",
    other: "{count} dépôts avec accès",
  },
  "config.accessNoRepo": "Aucun dépôt",
  "config.accessActions": "Actions de @{login}",
  "config.accessServerWide": "Serveur",
  "config.accessNoActionOn": "Aucune action sur {repos}",
  "config.accessOutside": "Absent des {users} de {repos}",
  "config.accessUndecided": "Indécidable : rien d’accordé ({error})",
  "config.accessNoAction": "Aucune action",
  "config.accessChipAllowed": "{meaning} · autorisé par {files}",
  "config.accessChipDenied": "Refusé par {file}",
  "config.accessChipDeniedWhy": "Refusé par {file} : {reason}",
  "config.accessAllowedBy": "Autorisé par {files}",
  "config.accessDeniedBy": "refusé par {files}",
  "config.accessDeniedByWhy": "refusé par {files} : {reasons}",
  "config.accessBoth": "Autorisé par {allowed} · refusé par {denied}",
  "config.accessBothWhy": "Autorisé par {allowed} · refusé par {denied} : {reasons}",

  // Settings › MCP clients: your machines (Machines.tsx)
  "machines.title": "Vos machines",
  "machines.warning":
    "Un agent tourne seul sur ces machines, avec vos fichiers, identifiants et réseau. Deckhand lui suggère des réglages et n’en impose aucun : ce qu’il peut y faire ne dépend que de vous.",
  "machines.unreadable": "Impossible de lire les machines : {error}",
  "machines.none":
    "Aucune machine enregistrée : le pilote d’une machine l’enregistre, connecté en votre nom.",
  "machines.reading": "Lecture…",
  "machines.online": "En ligne",
  "machines.offline": "Hors ligne",
  "machines.noLabels": "Aucun label",
  "machines.capacity": {
    one: "{count} exécution à la fois",
    other: "{count} exécutions à la fois",
  },
  "machines.seen": "vue {ago}",
  "machines.driver": "pilote {version}",
  "machines.repos": "Les dépôts qu’elle prend",
  "machines.remove": "Retirer",
  "machines.removeOne": "Retirer {name}",
} satisfies Section<typeof en>;
