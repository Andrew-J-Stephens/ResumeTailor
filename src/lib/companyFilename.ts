/**
 * Company name for downloads: model emits <!-- resume-tailor-company: ... --> in <head>;
 * we strip it from saved HTML. Heuristics fill in when the model omits or says Unknown.
 */

const META_COMMENT_RE = /<!--\s*resume-tailor-company:\s*([\s\S]*?)\s*-->/gi;

export function extractAndStripCompanyMeta(html: string): { html: string; company: string | null } {
  let company: string | null = null;
  const out = html.replace(META_COMMENT_RE, (_, c: string) => {
    if (!company) company = String(c).trim();
    return '';
  });
  return { html: out.replace(/\n{3,}/g, '\n\n').trim(), company };
}

export function sanitizeFilenameSegment(raw: string): string {
  let s = raw
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '');
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s;
}

/** Best-effort employer line from pasted job text (fallback if the model omits meta). */
export function extractCompanyFromJobText(job: string): string | null {
  const t = job.trim();
  if (!t) return null;

  const patterns: RegExp[] = [
    /(?:^|\n)\s*(?:company|employer|organization|hiring organization|hiring company)\s*[:#\-–—]\s*(.+?)(?:\n|$)/i,
    /(?:^|\n)\s*Posted by\s*[:#\-–—]?\s*(.+?)(?:\n|$)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (m?.[1]) {
      const name = m[1].trim().replace(/\s+/g, ' ');
      if (name.length >= 2 && name.length <= 120) return name;
    }
  }

  return null;
}

export function resolveCompanyForFilename(
  metaCompany: string | null,
  jobText: string
): string | null {
  const m = metaCompany?.trim();
  if (m && !/^unknown$/i.test(m)) {
    const s = sanitizeFilenameSegment(m);
    if (s && !/^unknown$/i.test(s)) return s;
  }
  const h = extractCompanyFromJobText(jobText);
  if (!h) return null;
  const s = sanitizeFilenameSegment(h);
  return s && !/^unknown$/i.test(s) ? s : null;
}

/** Local calendar date YYYY-MM-DD for download filenames. */
export function formatResumeDownloadDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function buildTailoredDownloadFilename(
  resumeBaseName: string,
  jobText: string,
  html: string,
  extension: 'html' | 'docx' | 'pdf' = 'html'
): { html: string; fileName: string } {
  const { html: stripped, company } = extractAndStripCompanyMeta(html);
  const companyPart = resolveCompanyForFilename(company, jobText);
  const base =
    resumeBaseName
      .replace(/\.html?$/i, '')
      .replace(/\.docx$/i, '')
      .replace(/\.pdf$/i, '')
      .trim() || 'resume';
  const date = formatResumeDownloadDate();
  const ext = extension;
  const fileName = companyPart
    ? `${companyPart}-resume-${date}.${ext}`
    : `${base}-resume-${date}.${ext}`;
  return { html: stripped, fileName };
}

export function buildCoverLetterDownloadFilename(
  resumeBaseName: string,
  jobText: string,
  extension: 'html' | 'docx' | 'pdf' = 'html'
): string {
  const companyPart = resolveCompanyForFilename(null, jobText);
  const base =
    resumeBaseName
      .replace(/\.html?$/i, '')
      .replace(/\.docx$/i, '')
      .replace(/\.pdf$/i, '')
      .trim() || 'resume';
  const date = formatResumeDownloadDate();
  return companyPart
    ? `${companyPart}-cover-letter-${date}.${extension}`
    : `${base}-cover-letter-${date}.${extension}`;
}
