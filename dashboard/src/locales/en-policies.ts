// English texts of Settings › a repository's policies (Policies.tsx, PolicyConfig.tsx) and Server (Server.tsx): spread into the catalog (en.ts).
export const policies = {
  // A task's Policies tab: each decision's name
  "policies.run": "Run refused",
  "policies.merge": "Auto-merge",
  "policies.review": "Automatic review",
  "policies.fix": "Fix run",
  "policies.linkBranch": "Linked branch",
  "policies.requestReview": "Reviewers requested",

  // A task's Policies tab: the decisions, newest first
  "policies.decisions": "Policy decisions, newest first",
  "policies.kept": "The last {kept} decisions are kept per task, for {days} days.",
  "policies.error": "Policy error",
  "policies.denied": "Denied",
  "policies.allowed": "Allowed",
  "policies.ofPr": "of #{pr}",
  "policies.reasons": { one: "{count} reason", other: "{count} reasons" },
  "policies.failClosed": "{error}: denied, fail closed",
  "policies.reasonsList": "Reasons",
  "policies.noDenial": "No rule denied it.",
  "policies.layers": "What each layer said",
  "policies.gatesFirst": "Built-in gates first:",
  "policies.input": "The input the rules saw",
  "policies.cut": "cut to fit",
  "policies.tooBig": "Too big to keep, even cut.",

  // A task's Policies tab: what each layer said
  "policies.operator": "Operator",
  "policies.repo": "Repo",
  "policies.notAsked": "not asked: not one of the repo's modes",
  "policies.matched": "matched",
  "policies.noMatch": "no rule matched",
  "policies.nothing": "nothing",
  "policies.inFiles": "{said} ({files})",

  // A task's Policies tab: a merge a policy kept for a human
  "policies.held": "A policy kept this pull request for a human",
  "policies.heldGates": "Deckhand's own gates passed {at}; then {then}",
  "policies.heldAt": "{at}: {then}",
  "policies.heldFailed": "{rule} failed, so it was denied: policies fail closed.",
  "policies.heldReturned": {
    one: "{rule} returned {count} reason.",
    other: "{rule} returned {count} reasons.",
  },
  "policies.mergeOnGithub": "Merge on GitHub ↗",

  // A task's Policies tab: the side cards
  "policies.side": "Policies",
  "policies.dryRun": "Dry run",
  "policies.dryRunHelp":
    "Comment {command} on the pull request to check every rule on its current state. Nothing is reviewed, fixed or merged.",
  "policies.lastBy": "Last one: by @{by} {at} · {denials}",
  "policies.last": "Last one: {at} · {denials}",
  "policies.denials": { one: "{count} denial", other: "{count} denials" },
  "policies.reply": "its reply ↗",
  "policies.noDryRun": "None yet on this pull request.",
  "policies.rules": "The rules",
  "policies.rulesHelp": "The policy files that apply to {repo}, and their errors.",
  "policies.repoPolicies": "{repo}'s policies →",

  // A repository's Policies tab: the header's badge while the check fails
  "policyConfig.trouble": "Policy error",
  "policyConfig.troubleFiles": {
    one: "{count} policy doesn't compile",
    other: "{count} policies don't compile",
  },

  // A repository's Policies tab: none at all
  "policyConfig.none": "No policies: only the built-in gates decide.",
  "policyConfig.noneHelp":
    "A repository adds some as {files} on {base}, the operator in their grants folder.",

  // A repository's Policies tab: the banner while the check fails
  "policyConfig.fileFails": "{file} doesn't compile: every decision a policy is asked for refuses",
  "policyConfig.cantCheck":
    "The policies can't be checked: every decision a policy is asked for refuses",
  "policyConfig.errors": {
    one: "{count} policy error: every decision a policy is asked for refuses",
    other: "{count} policy errors: every decision a policy is asked for refuses",
  },
  "policyConfig.failClosed": {
    one: "Policies fail closed, and each layer's files are checked together. Until it's fixed, auto-merges, automatic reviews, fix runs and runs' writes to GitHub here are all refused with “policy error”. Runs started by a comment still start.",
    other:
      "Policies fail closed, and each layer's files are checked together. Until they're fixed, auto-merges, automatic reviews, fix runs and runs' writes to GitHub here are all refused with “policy error”. Runs started by a comment still start.",
  },
  "policyConfig.lineLink": "Line {row} ↓",
  "policyConfig.line": "line {row} ↓",

  // A repository's Policies tab: warnings, and how policies work
  "policyConfig.warnings": "Policy warnings",
  "policyConfig.ignored": "Ignored",
  "policyConfig.warning": "Warning",
  "policyConfig.model":
    "After Deckhand's own gates, a decision is allowed when an {allow} rule matches and no {deny} rule does: a deny always wins. Deckhand's and the operator's files are one layer, the operator's replacing Deckhand's of the same name: their allow rules are the ceiling. The repo's files, read from {base}, are evaluated apart: their deny rules apply to every run, their allow rules only to the repo's own {modes}, which need the operator's allow too.",
  "policyConfig.githubInput":
    "{allow_github} and {deny_github} read the write ({action}, {target}, {change}), or a read of CI's checks or of projects ({action} {read_checks}, {read_projects}, no {target} or {change}), and the run: its {mode}, {custom_mode} (one of the repo's {modes}) and {reason} ({review_fix}, {ci_fix}, {conflict}, or null).",
  "policyConfig.githubInputLink": "The GitHub input",
  "policyConfig.pushInput":
    "{allow_push} and {deny_push} read each branch a run pushes, after the git gateway's own checks: the run's fields, the {branch}, whether the push {created} or {deleted} it, and the {default_branch}.",
  "policyConfig.pushInputLink": "The push input",
  "policyConfig.runInput":
    "{allow_run} and {deny_run} read the run a person asks for, before it is queued: its {mode}, {custom_mode}, {trigger} ({comment}, {dashboard}, {inbox}, {discussion}), {sender} and the {target} its comment is on ({kind}, {labels}, {author}).",
  "policyConfig.runInputLink": "The run input",

  // A repository's Policies tab: a card per decision, its name, what a denial does, and what
  // refuses it while the check fails or no allow rule matches ({until})
  "policyConfig.decisions": "Decisions",
  "policyConfig.decisionRun": "Runs people start",
  "policyConfig.deniesRun":
    "A denial starts no run (a trigger comment, /mode, a comment that goes on in a mode, the dashboard, an inbox entry, a discussion): the reply quotes the messages.",
  "policyConfig.refusedRun": "No run a person asks for starts {until}.",
  "policyConfig.allowsRunOwn":
    "Its allow rules decide where each mode runs: Deckhand's run.rego keeps brainstorms, /stop and onboarding on issues (a comment going on in a mode isn't refused).",
  "policyConfig.allowsRun": "Its allow rules decide where each mode runs.",
  "policyConfig.decisionMerge": "Auto-merge",
  "policyConfig.deniesMerge": "A denial keeps the pull request for a human: it isn't merged.",
  "policyConfig.refusedMerge": "Every auto-merge is refused {until}.",
  "policyConfig.decisionReview": "Automatic review",
  "policyConfig.deniesReview": "A denial skips the automatic review; /mode review still runs.",
  "policyConfig.refusedReview": "Automatic reviews are skipped {until}; /mode review still runs.",
  "policyConfig.decisionFix": "Fix run",
  "policyConfig.deniesFix":
    "A denial starts no fix run (a review's, a CI fix or a conflict's rebase); a comment on the pull request says why.",
  "policyConfig.refusedFix": "Every fix run is refused {until}.",
  "policyConfig.decisionLinkBranch": "Linked branch",
  "policyConfig.deniesLinkBranch":
    "A denial links no branch to the issue as a work run starts; the run creates its branch itself.",
  "policyConfig.refusedLinkBranch": "No branch is linked to an issue {until}.",
  "policyConfig.decisionRequestReview": "Reviewers",
  "policyConfig.deniesRequestReview":
    "A denial requests no reviewer (review.request) on Deckhand's pull request; the listener's log says why.",
  "policyConfig.refusedRequestReview": "No reviewer is requested {until}.",
  "policyConfig.decisionGithub": "GitHub writes and checks",
  "policyConfig.deniesGithub":
    "A denial refuses a run's write to GitHub (REST or GraphQL), or its reads of CI's checks (read_checks, as gh pr checks and gh pr view make) and of projects (read_projects); gh prints the messages to the agent.",
  "policyConfig.refusedGithub":
    "Every run's write to GitHub, and every read of CI's checks and of projects, is refused {until}.",
  "policyConfig.allowsGithub":
    "Its allow rules decide what each mode writes: Deckhand's mode-<mode>.rego, one file per mode.",
  "policyConfig.decisionPush": "Pushes",
  "policyConfig.deniesPush":
    "A denial refuses a run's push of a branch (the whole push): git prints the messages for each ref.",
  "policyConfig.refusedPush": "Every run's push is refused {until}.",
  "policyConfig.allowsPush":
    "Its allow rules decide which modes push: Deckhand's mode-work.rego, work runs and the repo's own modes (with the repo's allow too).",
  "policyConfig.untilChecked": "until the policies can be checked",
  "policyConfig.untilCompiles": { one: "until {files} compiles", other: "until {files} compile" },
  "policyConfig.untilAllowed": "while no allow rule of the operator's matches it",
  "policyConfig.nothingDenies": "Nothing denies it: only Deckhand's own gates decide.",

  // A repository's Policies tab: a decision card's state and each layer's rules
  "policyConfig.refused": "Refused",
  "policyConfig.neverAllowed": "Never allowed",
  "policyConfig.active": "Active",
  "policyConfig.noDenyRule": "No deny rule",
  "policyConfig.noRule": "no {rule}",
  "policyConfig.noAllowRule": "no allow rule",
  "policyConfig.repoAllowIgnored": "{said}: ignored, no mode of the repo's makes it",
  "policyConfig.repoAllowOwn": "{said}, for its own modes",
  "policyConfig.operatorRules": "Operator: {allow} · {deny}",
  "policyConfig.repoRules": "Repo: {allow} · {deny}",

  // A repository's Policies tab: the policy files' table
  "policyConfig.files": "Policy files",
  "policyConfig.filesNote": {
    one: "{count} file · {counts} · Deckhand's and the operator's merged by name, the repo's apart",
    other:
      "{count} files · {counts} · Deckhand's and the operator's merged by name, the repo's apart",
  },
  "policyConfig.fromDeckhand": "{count} from Deckhand",
  "policyConfig.fromOperator": "{count} from the operator",
  "policyConfig.fromRepo": "{count} from the repo",
  "policyConfig.columnFile": "File",
  "policyConfig.columnFrom": "From",
  "policyConfig.columnEffect": "Effect",
  "policyConfig.columnRules": "Rules",
  "policyConfig.columnCompiles": "Compiles",
  "policyConfig.tagDeckhand": "deckhand",
  "policyConfig.tagOperator": "operator",
  "policyConfig.tagRepo": "repo",
  "policyConfig.ownerDeckhand": "Deckhand's",
  "policyConfig.ownerOperator": "the operator's",
  "policyConfig.ownerRepo": "the repo's",
  "policyConfig.replacedBy": "Replaced by {owner}",
  "policyConfig.replaces": "Replaces {owner}",
  "policyConfig.added": "Added",
  "policyConfig.kept": "Default, kept",
  "policyConfig.noRules": "no rule",
  "policyConfig.compilesError": "Error",
  "policyConfig.compilesUnknown": "Unknown",
  "policyConfig.compilesYes": "Yes",

  // A repository's Policies tab: a file's source, folded
  "policyConfig.sourceReplaces": "replaces {owner} {name}",
  "policyConfig.sourceReplacedBy": "replaced by {owner}: not evaluated",
  "policyConfig.lines": { one: "{count} line", other: "{count} lines" },
  "policyConfig.truncated": "its first 20 KB",
  "policyConfig.sourceErrors": { one: "{count} error", other: "{count} errors" },
  "policyConfig.edit": "Edit on GitHub",

  // A repository's Policies tab: trying them on a pull request
  "policyConfig.try": "Try them on a pull request",
  "policyConfig.tryHelp":
    "Comment {command} on it: Deckhand replies with each decision's result, what each layer's rules said, and the input they saw. Nothing is reviewed, fixed or merged.",
  "policyConfig.copy": "Copy the command",
  "policyConfig.copied": "Copied",
  "policyConfig.copyFailed": "Couldn't copy",

  // Settings › Server: the listener's status
  "server.unreachable": "Can't reach the listener",
  "server.up": "The listener is up",
  "server.loading": "Loading…",
  "server.version": "Deckhand {version} · up {uptime}, since {since} · Node {node}",
  "server.versionFrom":
    "Deckhand {version} · up {uptime}, since {since} · Node {node} · built from {repo}",
  "server.operatorNote":
    "Its operator changes these in the server's environment and grants folder.",

  // Settings › Server: runs, the engine, the proxy and the grants folder
  "server.runs": "Runs",
  "server.slots": "Slots",
  "server.running": "{count} running",
  "server.plans": "Plans",
  "server.engine": "Container engine",
  "server.engineSysbox": "Sysbox",
  "server.enginePodman": "Podman",
  "server.engineAuto": "Sysbox, else Podman",
  "server.engineNone": "None",
  "server.noCredential": "No credential set",
  "server.credentialFallback": "{label} first, then {fallbacks} as fallback",
  "server.credentialsAlso": "{names} also set",
  "server.unread": "Couldn't read ({error})",
  "server.proxy": "Egress proxy",
  "server.proxyOn": "On",
  "server.proxyOff": "Off",
  "server.hostsUncounted": "hosts not counted",
  "server.hosts": { one: "{count} host granted", other: "{count} hosts granted" },
  "server.grants": "Grants folder",
  "server.grantsOk": "Read, no errors",
  "server.grantsErrorsIn": "Errors in {file}",
  "server.grantsErrors": "Errors",

  // Settings › Server: the GitHub App
  "server.app": "GitHub App",
  "server.appSettings": "App settings",
  "server.appSettingsLink": "App settings ↗",
  "server.install": "Install on another account",
  "server.name": "Name",
  "server.installedOn": "Installed on",
  "server.noAccount": "No account yet",
  "server.anAccount": "An account",
  "server.lacks": "lacks {missing}",
  "server.acceptPermissions": "accept new permissions ↗",
  "server.configure": "configure ↗",
  "server.missing": "Missing in its settings",
  "server.missingPermissions": {
    one: "{count} permission: {names}",
    other: "{count} permissions: {names}",
  },
  "server.addPermissions": {
    one: "add it under Permissions, then accept it on each installation",
    other: "add them under Permissions, then accept them on each installation",
  },
  "server.missingEvents": { one: "{count} event: {names}", other: "{count} events: {names}" },
  "server.addEvents": {
    one: "turn it on under Subscribe to events",
    other: "turn them on under Subscribe to events",
  },
  "server.users": "Who can sign in",
  "server.repos": "Allowed repositories",
  "server.everyRepo": "Every repository the App is installed on",

  // Settings › Server: the webhook deliveries and the last sync
  "server.deliveries": "Webhook deliveries",
  "server.noSync": "No sync yet.",
  "server.syncFailed": "Last sync {when} failed: {error}",
  "server.syncUpToDate": "Last sync {when}: up to date with GitHub.",
  "server.synced": "Last sync {when}: {done}.",
  "server.sync": "Sync now",
  "server.syncing": "Syncing…",
  "server.syncHelp":
    "Ask GitHub again for the webhook deliveries it couldn't hand over, for the open pull requests' states, and whether they still merge",
} as const;
