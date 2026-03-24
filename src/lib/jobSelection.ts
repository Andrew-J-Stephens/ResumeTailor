/**
 * Job description text from the active tab: only what the user highlighted.
 * Strip any tag-like fragments, cap length, normalize whitespace (no page HTML/CSS/JS).
 * Kept moderate to trim prompt tokens / cost.
 */
export const MAX_JOB_DESCRIPTION_CHARS = 8_000;

export function normalizeJobDescriptionFromPage(raw: string): string {
  let t = raw.trim();
  if (!t) return '';

  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/\u00a0/g, ' ');
  t = t.replace(/[ \t]+\n/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.replace(/[ \t]{2,}/g, ' ');

  if (t.length > MAX_JOB_DESCRIPTION_CHARS) {
    t = t.slice(0, MAX_JOB_DESCRIPTION_CHARS).trimEnd();
  }
  return t.trim();
}
