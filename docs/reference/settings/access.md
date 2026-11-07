# Access and GitHub

Who may start runs and sign in to the dashboard, on which repositories, and what a comment
starts with. These narrow everything else: an author out of `ALLOWED_USERS`, or a repository
out of `ALLOWED_REPOS`, starts nothing, whatever a repository's `.deckhand.yaml` or your
policies say ([how settings are read](../settings.md#how-settings-are-read)).

## Settings

- **`ALLOWED_USERS`** · `allowed_users` · required\
  GitHub logins that can start runs and sign in to the dashboard (edge and the orchestrator both read it).
- **`ALLOWED_REPOS`** · `allowed_repos` · default: all where the App is installed\
  Narrows the repos (`owner/repo`, or `owner/*` for every repo of an account, comma-separated in `.env`; see [Which repositories](../../guides/repositories.md#which-repositories)); edge reads it too, to pass on CI's deliveries for those repos only.
- **`TRIGGER`** · `trigger` · default: `Deckhand`\
  First line of a comment that starts a run.
- **`ONBOARDING`** · `onboarding` · default: on\
  `off`: no onboarding issue when the App is installed on a repo without a config.
- **`NEEDS_INPUT_LABEL`** · `needs_input_label` · default: `needs-input`\
  Label while a run or an issue waits for answers (empty: none).
- **`PUBLIC_URL`** · `public_url` · default: stored by `/setup`\
  Edge's public address.
- **`GITHUB_URL`, `GITHUB_API`** · `github_url`, `github_api` · default: `https://github.com`, `https://api.github.com`\
  GitHub's web and API addresses, always allowed through the egress proxy.

## Beyond these

- **Which repositories**: `ALLOWED_REPOS`'s patterns (`owner/*`), and what a wildcard
  implies: [Which repositories](../../guides/repositories.md#which-repositories).
- **Who may do what**: `ALLOWED_USERS` lets someone in; your policies' access rules say what
  they may do there, repository by repository (start runs, read live logs, stop runs…):
  [Access](../../repo-config/policies.md#access).
- **A repository's own `users`** narrow `ALLOWED_USERS` there, never widen it
  ([Keys](../../repo-config.md#keys)).
- **What a comment starts with**: the trigger line and the commands after it:
  [Comment commands](../comment-commands.md).
