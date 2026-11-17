// Every model call FRIDAY makes gets this line (engines.completeWithMeta). Clients are US firms and a
// client flagged British spellings in generated text (2026-11-13), so client email, portal updates,
// documents and the site copy coding runs write all come out in US English.
export const US_SPELLING_RULE =
  "Write in American English with US spelling (color, behavior, organize, recognize, analyze, center, " +
  "practice as a verb, judgment, labeled, canceled, favor, gray). Leave quotes, names, code identifiers " +
  "and text you are not rewriting exactly as they are.";

/** The system prompt with the spelling rule appended once. */
export function withUsSpelling(system: string | undefined): string {
  if (system?.includes(US_SPELLING_RULE)) return system;
  return system ? `${system}\n\n${US_SPELLING_RULE}` : US_SPELLING_RULE;
}
