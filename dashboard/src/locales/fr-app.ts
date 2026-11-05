// French texts of the page's frame: App.tsx, the palette, the chooser, the shortcuts and their help (Palette.tsx, Chooser.tsx, Shortcuts.tsx, keys.ts), notifications (notify.ts): spread into the French catalog (fr.ts).
import type { Section } from ".";
import type { app as en } from "./en-app";

export const app = {
  // The shortcuts' groups and names (keys.ts SHORTCUTS)
  "app.shortcutsEverywhere": "Partout",
  "app.shortcutsTasks": "Tâches",
  "app.shortcutsRunLog": "Journal d’exécution",
  "app.shortcutsBoard": "Tableau",
  "app.shortcutHelp": "Ces raccourcis",
  "app.shortcutPalette": "Aller à un dépôt, une tâche ou une action",
  "app.shortcutRequest": "Nouvelle demande",
  "app.shortcutOverview": "Vue d’ensemble",
  "app.shortcutTasks": "Tâches",
  "app.shortcutBoard": "Tableau",
  "app.shortcutSettings": "Paramètres",
  "app.shortcutSidebar": "Replier la barre latérale",
  "app.shortcutTheme": "Thème : système, clair, sombre",
  "app.shortcutBack": "Fermer ou revenir",
  "app.shortcutSearch": "Rechercher des tâches",
  "app.shortcutNextTask": "Tâche suivante / précédente",
  "app.shortcutFilter": "Filtre : Toutes … Erreur",
  "app.shortcutGithub": "Ouvrir sur GitHub",
  "app.shortcutAnswer": "Répondre à ses questions",
  "app.shortcutRerun": "Relancer une exécution échouée",
  "app.shortcutReview": "Relancer la revue de sa pull request",
  "app.shortcutFix": "Un tour de correction de plus",
  "app.shortcutStop": "Arrêter l’exécution (avec confirmation)",
  "app.shortcutNextRun": "Exécution suivante / précédente",
  "app.shortcutLogSearch": "Rechercher dans le journal",
  "app.shortcutMatch": "Résultat suivant / précédent",
  "app.shortcutExpand": "Déplier toutes les sections",
  "app.shortcutCollapse": "Replier toutes les sections",
  "app.shortcutError": "Erreur suivante / précédente",
  "app.shortcutFollow": "Suivre en direct, aller à la fin",
  "app.shortcutCopy": "Copier le journal",
  "app.shortcutMove": "Passer d’une carte à l’autre",
  "app.shortcutOpen": "Ouvrir la tâche de la carte",
  "app.shortcutStart": "Lancer l’issue sélectionnée",
  "app.shortcutQueue": "La mettre en file après…",
  "app.shortcutBrainstorm": "En faire un brainstorm",
  "app.shortcutView": "Graphe / colonnes",
  "app.shortcutClosed": "Afficher les fermées",
  "app.shortcutZoom": "Zoomer, dézoomer, ajuster",
  "app.shortcutPan": "Se déplacer",

  // The words between a shortcut's keys: "G then O", "J or K", "1 to 6", "Space + drag"
  "app.keysThen": "puis",
  "app.keysOr": "ou",
  "app.keysTo": "à",
  "app.keysDrag": "+ glisser",
  "app.withKey": "{title} ({keys})",

  // The `?` sheet (Shortcuts.tsx)
  "app.shortcutsTitle": "Raccourcis clavier",
  "app.shortcutsSub": "Appuyez sur {key} n’importe où pour les afficher",
  "app.shortcutsHint":
    "Les raccourcis ne se déclenchent jamais pendant la saisie dans un champ. Sur Mac, Ctrl correspond à ⌘. {link}",
  "app.shortcutsOff": "Les désactiver dans les Préférences",

  // Ctrl K (Palette.tsx)
  "app.paletteTasks": "Tâches",
  "app.paletteRepositories": "Dépôts",
  "app.paletteBoard": "Tableau",
  "app.paletteActions": "Actions",
  "app.paletteLane": "Afficher la colonne {lane} du tableau de {repo}",
  "app.paletteIdea": "Nouvelle idée",
  "app.paletteIdeaTitled": "Nouvelle idée : « {title} »",
  "app.paletteBug": "Nouveau rapport de bug",
  "app.paletteBugTitled": "Nouveau rapport de bug : « {title} »",
  "app.paletteAnalyze": "Analyser les exécutions",
  "app.paletteSync": "Synchroniser avec GitHub",
  "app.paletteThemeSystem": "Thème : système",
  "app.paletteThemeLight": "Thème : clair",
  "app.paletteThemeDark": "Thème : sombre",
  "app.paletteLabel": "Aller à",
  "app.palettePlaceholder": "Aller à une tâche, un dépôt ou une action",
  "app.paletteInput": "Aller à un dépôt, une tâche ou une action",
  "app.paletteResults": "Résultats",
  "app.paletteNothing": "Rien ne correspond à « {query} ».",
  "app.paletteMove": "{keys} naviguer",
  "app.paletteOpen": "{keys} ouvrir",
  "app.paletteOpenGithub": "{keys} ouvrir sur GitHub",
  "app.paletteTip": "Tapez un numéro (#23), un dépôt ou une action",

  // Queue after… (Chooser.tsx)
  "app.chooserTitle": "Mettre {number} en file après…",
  "app.chooserSub": "Elle démarre une fois l’issue choisie terminée.",
  "app.chooserKeys": "{arrows} choisir · {enter} mettre en file",
  "app.chooserCancel": "Annuler",
  "app.chooserQueue": "Mettre en file",
  "app.chooserQueueAfter": "En file après {number}",
  "app.chooserFilter": "Filtrer les issues",
  "app.chooserPlaceholder": "Filtrer par numéro ou titre",
  "app.chooserIssues": "Issues du tableau",
  "app.chooserNoMatch": "Aucune issue ne correspond.",
  "app.chooserNone": "Aucune issue du tableau après laquelle la mettre en file.",

  // The tab's title and the browser notifications (notify.ts)
  "app.tabTitleReady": "({count}) Deckhand",
  "app.notifyReady": "Prête pour la revue : {title}",
  "app.notifyReadyBody": "{repo} · pull request #{number}",
  "app.notifyReadyBodyLeft": "{repo} · pull request #{number} · {left}",
  "app.notifyInput": "Attend vos réponses : {title}",
  "app.notifyInputBrainstorm": "{repo} · un brainstorm attend votre tour",
  "app.notifyInputQuestions": "{repo} · questions ouvertes",
  "app.notifyFailed": "Exécution échouée : {title}",
  "app.notifyFailedBody": "{repo} · {state}",
  "app.notifyTest": "Les notifications fonctionnent dans ce navigateur.",

  // Settings (Settings.tsx)
  "app.settingsRefused":
    "Cette page ne vous est pas accessible : elle demande {permission}, que donnent les politiques de l’opérateur.",

  // The dashboard's own errors (api.ts)
  "app.noRepository": "Aucun dépôt.",
} satisfies Section<typeof en>;
