// The severity scale the reviews' findings and the repos' `severity: *` labels share, most
// severe first (#866): one module, as reviews.mjs already imports auto-pickup.mjs.
export const SEVERITIES = ["critical", "high", "medium", "low"];

// An issue's rank on that scale from its labels, `severity: <x>` matched case-insensitively:
// the most severe one's index, or SEVERITIES.length (after `low`) without one.
export function severityRank(labels = []) {
  let rank = SEVERITIES.length;
  for (const label of labels) {
    const name = String(typeof label === "string" ? label : (label?.name ?? "")).toLowerCase();
    const match = /^severity:\s*(\S+)$/.exec(name.trim());
    const index = match ? SEVERITIES.indexOf(match[1]) : -1;
    if (index >= 0 && index < rank) rank = index;
  }
  return rank;
}
