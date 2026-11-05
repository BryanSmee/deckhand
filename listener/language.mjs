// The repo's `language` line (repo-config.mjs): what ends a run's prompt (prompts.mjs
// promptFor()) and what the sandbox ends a continued session's with (sandbox-spec.mjs
// TASK_LANGUAGE). A module of its own, reading no file: the runner's image imports
// sandbox-spec.mjs without prompts/ or docs/, which prompts.mjs reads as it loads.

// Last in what the agent reads, so the English around it doesn't win: what people read only.
// The tokens the listener parses stay English, and a review's whole format, which
// parseReview() (reviews.mjs) reads in English alone.
export function languageLine(language, mode) {
  const review =
    mode === "review"
      ? "; in a review, so does its format: the `## Must fix`, `## Follow-ups` and `## Comments` headings, the severities (`critical`, `high`, `medium`, `low`), `blocking` and `note`, `None.`, and the `Rating: <n>/10` and `Verdict: approve|comment|request-changes` lines, words and values as your prompt writes them"
      : "";
  return `Write in ${language} everything this run produces for people (replies, issues, pull requests, comments); code, code comments and commit messages stay in English unless the repository's instructions say otherwise, and so do the parts the listener reads (\`<!-- needs-input -->\`, \`Open questions\`, \`None\`, \`(recommended)\`: see Open questions in your instructions)${review}.`;
}
