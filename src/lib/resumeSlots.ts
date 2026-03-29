/**
 * Resume tailor reads/writes only elements marked with data-resume-slot.
 * Lists use data-resume-slot="experience-0", "project-1", etc. (zero-based indices).
 */

export const SKILL_SLOT_IDS = [
  'skill-programmingLanguages',
  'skill-cloudDevOps',
  'skill-apisDatabases',
  'skill-testingDeployment',
] as const;

export type SkillSlotId = (typeof SKILL_SLOT_IDS)[number];

const SLOT_INDEX_RE = /^(.+)-(\d+)$/;

function slotNumericSuffix(el: Element): number {
  const slot = el.getAttribute('data-resume-slot') ?? '';
  const m = slot.match(SLOT_INDEX_RE);
  return m ? parseInt(m[2], 10) : -1;
}

/** ULs whose data-resume-slot matches `prefix-N` (e.g. experience-0), sorted by N. */
export function getSortedUlsBySlotPrefix(root: Document | HTMLElement, prefix: string): Element[] {
  const re = new RegExp(`^${prefix}-\\d+$`);
  const uls = Array.from(root.querySelectorAll(`[data-resume-slot^="${prefix}-"]`)).filter(
    (n) => n.tagName === 'UL' && re.test(n.getAttribute('data-resume-slot') ?? '')
  );
  uls.sort((a, b) => slotNumericSuffix(a) - slotNumericSuffix(b));
  return uls;
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

  const experience = getSortedUlsBySlotPrefix(body, 'experience');
  if (experience.length === 0) {
    errors.push('Need at least one <ul data-resume-slot="experience-0"> (and more with experience-1, …).');
  }
  for (const ul of experience) {
    const slot = ul.getAttribute('data-resume-slot') ?? '';
    const lis = ul.querySelectorAll(':scope > li');
    if (lis.length === 0) {
      errors.push(`${slot}: add at least one <li>.`);
    }
  }

  const projects = getSortedUlsBySlotPrefix(body, 'project');
  for (const ul of projects) {
    const slot = ul.getAttribute('data-resume-slot') ?? '';
    if (ul.querySelectorAll(':scope > li').length === 0) {
      errors.push(`${slot}: add at least one <li>.`);
    }
  }

  const awards = getSortedUlsBySlotPrefix(body, 'award');
  for (const ul of awards) {
    const slot = ul.getAttribute('data-resume-slot') ?? '';
    if (ul.querySelectorAll(':scope > li').length === 0) {
      errors.push(`${slot}: add at least one <li>.`);
    }
  }

  for (const id of SKILL_SLOT_IDS) {
    if (!body.querySelector(`[data-resume-slot="${id}"]`)) {
      errors.push(`Missing element with data-resume-slot="${id}".`);
    }
  }

  return { ok: errors.length === 0, errors };
}
