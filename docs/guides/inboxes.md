# Inboxes

How to give a repository a place for ideas, bug reports and questions that Claude handles
without a trigger line. Read it once Deckhand runs on the repository
([Repositories and onboarding](repositories.md)). Every key and rule:
[Inboxes](../repo-config/issues.md#inboxes) in the `.deckhand.yaml` reference.

## Ideas and bug reports

1. Open an issue for each inbox, for example "Ideas" and "Bugs", and pin them.
2. Name them in the repository's `.deckhand.yaml`, on its default branch:

   ```yaml
   inbox:
     ideas: 3 # issue number
     bugs: 4 # issue number
   ```

3. Comment on the inbox issue. Each comment is an entry: Claude reads the code, looks for an
   issue that already covers it, and files one (labelled `idea` or `bug`) or links the one it
   found, in its reply on the inbox.

Only allowed users' comments are read. An entry is a light run, like a brainstorm: no branch, no
`setup`, the brainstorm agent and model (`brainstorm_agent`, `brainstorm_model`). `/agent`,
`/model`, `/effort` and `/speed` may end any line of an entry
([Commands on the trigger's line](runs.md#commands-on-the-triggers-line)). The dashboard's
**New request** sends entries too ([The dashboard](dashboard.md)).

## Questions in GitHub Discussions

1. Turn on Discussions in the repository's settings, and create a category for Deckhand, for
   example "Ask Claude".
2. Name it in `.deckhand.yaml`:

   ```yaml
   inbox:
     discussions: Ask Claude # GitHub Discussions category
   ```

3. Start a discussion in that category. Claude answers it, and every later comment of an allowed
   user, in the thread of the comment it answers; when the discussion settles on something to
   build, it files an issue and links it.

Other categories are never read. An App created before Deckhand answered discussions needs the
Discussions permission and events first:
[Apps created before an event](github-app.md#apps-created-before-an-event).
