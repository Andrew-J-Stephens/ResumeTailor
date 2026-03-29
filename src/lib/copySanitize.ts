/** Month names for date-range detection (English resumes). */
const MONTH_GROUP =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December)';

/**
 * Remove em/en dashes and spaced hyphens used as phrase separators.
 * Date ranges like "May 2020 - Aug 2021" or "Jan 2020 to Present" become "May 2020 to Aug 2021".
 * Used after AI import and tailoring so output matches product copy rules.
 */
export function sanitizeResumeCopyDashes(s: string): string {
  if (!s) return s;
  let t = s.replace(/\u2014/g, ', ').replace(/\u2013/g, ', ');
  const Mg = MONTH_GROUP;
  t = t.replace(
    new RegExp(
      `(\\b${Mg}\\s+\\d{4})\\s*[-\\u2013\\u2014]\\s*(?:(${Mg}\\s+\\d{4})|(Present|present)\\b)`,
      'gi'
    ),
    (_, a: string, b: string | undefined, pres: string | undefined) =>
      b ? `${a} to ${b}` : `${a} to ${pres ?? ''}`
  );
  t = t.replace(/\s+-\s+/g, ', ');
  return t.replace(/\s*,\s*/g, ', ').replace(/,\s*,+/g, ',').replace(/^,\s*|\s*,$/g, '').trim();
}
