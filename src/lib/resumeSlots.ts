/**
 * Resume tailor reads/writes only elements marked with data-resume-slot.
 * Bullet sections: ul sec-{sectionId}-{blockIndex}
 * Skills sections: skill-{sectionId}-{rowIndex} on value spans
 */

/** Safe section id for slot attributes: letter-first, then letters, digits, underscore. */
export const SECTION_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export function isValidSectionId(id: string): boolean {
  return SECTION_ID_PATTERN.test(id);
}

function escapeIdForRe(id: string): string {
  return id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ULs with data-resume-slot sec-{sectionId}-N, sorted by N. */
export function getSortedSectionBlockUls(root: Document | HTMLElement, sectionId: string): Element[] {
  if (!isValidSectionId(sectionId)) return [];
  const prefix = `sec-${sectionId}-`;
  const uls = Array.from(root.querySelectorAll(`[data-resume-slot^="${prefix}"]`)).filter(
    (n) => n.tagName === 'UL'
  );
  const re = new RegExp(`^sec-${escapeIdForRe(sectionId)}-(\\d+)$`);
  const filtered = uls.filter((n) => re.test(n.getAttribute('data-resume-slot') ?? ''));
  filtered.sort((a, b) => {
    const sa = a.getAttribute('data-resume-slot') ?? '';
    const sb = b.getAttribute('data-resume-slot') ?? '';
    const ma = sa.match(re);
    const mb = sb.match(re);
    const na = ma ? parseInt(ma[1]!, 10) : 0;
    const nb = mb ? parseInt(mb[1]!, 10) : 0;
    return na - nb;
  });
  return filtered;
}

/** Value elements for a skills section, sorted by row index. */
export function getSortedSkillValueElements(root: Document | HTMLElement, sectionId: string): Element[] {
  if (!isValidSectionId(sectionId)) return [];
  const prefix = `skill-${sectionId}-`;
  const re = new RegExp(`^skill-${escapeIdForRe(sectionId)}-(\\d+)$`);
  const els = Array.from(root.querySelectorAll(`[data-resume-slot^="${prefix}"]`)).filter((n) =>
    re.test(n.getAttribute('data-resume-slot') ?? '')
  );
  els.sort((a, b) => {
    const na = parseInt(a.getAttribute('data-resume-slot')!.match(re)![1]!, 10);
    const nb = parseInt(b.getAttribute('data-resume-slot')!.match(re)![1]!, 10);
    return na - nb;
  });
  return els;
}

export function validateResumeSlots(body: HTMLElement | null): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!body) {
    errors.push('Document has no <body>.');
    return { ok: false, errors };
  }

  if (!body.querySelector('[data-resume-slot="summary"]')) {
    errors.push('Missing an element with data-resume-slot="summary".');
  }

  const sectionTitles = body.querySelectorAll('p.section-title[data-resume-section-id]');
  if (sectionTitles.length === 0) {
    errors.push(
      'Need at least one <p class="section-title" data-resume-section-id="…" data-resume-section-kind="bullets|skills">.'
    );
  }

  for (const titleEl of Array.from(sectionTitles)) {
    const sid = titleEl.getAttribute('data-resume-section-id') ?? '';
    const kind = titleEl.getAttribute('data-resume-section-kind') ?? '';
    if (!isValidSectionId(sid)) {
      errors.push(`Invalid data-resume-section-id "${sid}" (use letter-first, then letters, digits, underscore).`);
      continue;
    }
    if (kind !== 'bullets' && kind !== 'skills') {
      errors.push(`Section "${sid}": data-resume-section-kind must be "bullets" or "skills".`);
      continue;
    }
    if (kind === 'bullets') {
      const uls = getSortedSectionBlockUls(body, sid);
      if (uls.length === 0) {
        errors.push(`Bullets section "${sid}": add at least one <ul data-resume-slot="sec-${sid}-0"> (and sec-${sid}-1, …).`);
      }
      for (const ul of uls) {
        const slot = ul.getAttribute('data-resume-slot') ?? '';
        if (ul.querySelectorAll(':scope > li').length === 0) {
          errors.push(`${slot}: add at least one <li>.`);
        }
      }
    } else {
      const skillEls = getSortedSkillValueElements(body, sid);
      if (skillEls.length === 0) {
        errors.push(
          `Skills section "${sid}": add at least one value span with data-resume-slot="skill-${sid}-0".`
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
