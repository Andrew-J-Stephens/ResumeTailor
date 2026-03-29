import { DOMParser } from 'linkedom';
import { sanitizeResumeCopyDashes } from './copySanitize';
import { buildSlottedResumeHtml, SAMPLE_RESUME_BUILDER_CONFIG } from './resumeTemplateGenerator';
import {
  getSortedSectionBlockUls,
  getSortedSkillValueElements,
  validateResumeSlots,
} from './resumeSlots';

export type TailorSectionBullets = {
  id: string;
  type: 'bullets';
  lists: string[][];
};

export type TailorSectionSkills = {
  id: string;
  type: 'skills';
  values: string[];
};

export type TailorPointsJson = {
  company: string;
  summary: string;
  sections: (TailorSectionBullets | TailorSectionSkills)[];
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeComment(text: string): string {
  return text.replace(/--/g, ' ').trim();
}

/** Default template HTML for tailoring when the user has not saved a custom one. */
export function getBundledResumeTemplateHtml(): string {
  return buildSlottedResumeHtml(SAMPLE_RESUME_BUILDER_CONFIG);
}

function parseDoc(html: string) {
  return new DOMParser().parseFromString(html, 'text/html') as unknown as Document;
}

function listItemPlainTexts(ul: Element): string[] {
  return Array.from(ul.querySelectorAll(':scope > li')).map((li) =>
    (li.textContent ?? '').replace(/\s+/g, ' ').trim()
  );
}

/** Section order and shape follow <p.section-title> markers in the document. */
export function extractTailorSnapshot(html: string): TailorPointsJson {
  const doc = parseDoc(html);
  const body = doc.body;
  if (!body) throw new Error('Template has no body.');

  const bodyEl = body as unknown as HTMLElement;
  const v = validateResumeSlots(bodyEl);
  if (!v.ok) {
    throw new Error(
      `Invalid resume template:\n${v.errors.join('\n')}\nOpen Template builder to fix or reset.`
    );
  }

  const summaryEl = body.querySelector('[data-resume-slot="summary"]');
  const summary = (summaryEl?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const sections: TailorPointsJson['sections'] = [];
  const titles = body.querySelectorAll('p.section-title[data-resume-section-id]');
  for (const titleEl of Array.from(titles)) {
    const id = titleEl.getAttribute('data-resume-section-id') ?? '';
    const kind = titleEl.getAttribute('data-resume-section-kind') ?? '';
    if (kind === 'bullets') {
      const uls = getSortedSectionBlockUls(bodyEl, id);
      const lists = uls.map((ul) => listItemPlainTexts(ul));
      sections.push({ id, type: 'bullets', lists });
    } else if (kind === 'skills') {
      const els = getSortedSkillValueElements(bodyEl, id);
      const values = els.map((el) =>
        (el.textContent ?? '').replace(/^\u00a0\s*/, '').replace(/\s+/g, ' ').trim()
      );
      sections.push({ id, type: 'skills', values });
    }
  }

  return {
    company: 'Unknown',
    summary,
    sections,
  };
}

function normalizeBulletArray(
  incoming: unknown,
  len: number,
  fallback: string[]
): string[] {
  const arr = Array.isArray(incoming) ? incoming : [];
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    const raw = arr[i];
    const t = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    const fb = fallback[i] ?? '';
    out.push(t.length > 0 ? t : fb);
  }
  return out;
}

function stripOuterCodeFences(s: string): string {
  let h = s.trim();
  if (h.startsWith('```')) {
    h = h.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/s, '').trim();
  }
  return h;
}

function normalizeIncomingSection(
  raw: unknown,
  base: TailorSectionBullets | TailorSectionSkills
): TailorSectionBullets | TailorSectionSkills {
  if (!raw || typeof raw !== 'object') {
    return base.type === 'bullets'
      ? { ...base, lists: base.lists.map((row) => [...row]) }
      : { ...base, values: [...base.values] };
  }
  const o = raw as Record<string, unknown>;
  if (base.type === 'bullets') {
    const listsIn = Array.isArray(o.lists) ? o.lists : [];
    const lists = base.lists.map((fb, i) =>
      normalizeBulletArray(listsIn[i], fb.length, fb)
    );
    return { id: base.id, type: 'bullets', lists };
  }
  const valsIn = Array.isArray(o.values) ? o.values : [];
  const values = base.values.map((fb, i) => {
    const rawV = valsIn[i];
    const t = typeof rawV === 'string' ? rawV.replace(/\s+/g, ' ').trim() : '';
    return t.length > 0 ? t : fb;
  });
  return { id: base.id, type: 'skills', values };
}

export function parseTailorPointsFromAssistant(raw: string, base: TailorPointsJson): TailorPointsJson {
  const trimmed = stripOuterCodeFences(raw);
  if (!trimmed) throw new Error('Empty response from AI.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first < 0 || last <= first) {
      throw new Error('AI did not return JSON. Expected a single JSON object.');
    }
    parsed = JSON.parse(trimmed.slice(first, last + 1));
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI JSON must be an object.');
  }
  const obj = parsed as Record<string, unknown>;

  const companyRaw = obj.company;
  const company =
    typeof companyRaw === 'string' ? companyRaw.replace(/\s+/g, ' ').trim() : '';
  const summaryRaw = obj.summary;
  const summary =
    typeof summaryRaw === 'string' ? summaryRaw.replace(/\s+/g, ' ').trim() : '';

  const sectionsIn = Array.isArray(obj.sections) ? obj.sections : [];
  const byId = new Map<string, unknown>();
  for (const s of sectionsIn) {
    if (s && typeof s === 'object' && typeof (s as Record<string, unknown>).id === 'string') {
      byId.set((s as Record<string, string>).id, s);
    }
  }

  const sections = base.sections.map((b, idx) => {
    const incoming = byId.get(b.id) ?? sectionsIn[idx];
    return normalizeIncomingSection(incoming, b);
  });

  const sanitizeSection = (s: TailorSectionBullets | TailorSectionSkills) => {
    if (s.type === 'bullets') {
      return {
        id: s.id,
        type: 'bullets' as const,
        lists: s.lists.map((row) => row.map(sanitizeResumeCopyDashes)),
      };
    }
    return {
      id: s.id,
      type: 'skills' as const,
      values: s.values.map(sanitizeResumeCopyDashes),
    };
  };

  return {
    company: sanitizeResumeCopyDashes(company || 'Unknown'),
    summary: sanitizeResumeCopyDashes(summary.length > 0 ? summary : base.summary),
    sections: sections.map(sanitizeSection),
  };
}

function setBulletList(ul: Element, texts: string[]): void {
  const lis = Array.from(ul.querySelectorAll(':scope > li'));
  if (lis.length !== texts.length) {
    throw new Error(`Template bullet count mismatch: expected ${lis.length}, got ${texts.length}.`);
  }
  for (let i = 0; i < lis.length; i++) {
    lis[i].innerHTML = escapeHtml(texts[i] ?? '');
  }
}

function injectCompanyHead(html: string, company: string): string {
  const safe = escapeComment(company || 'Unknown');
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(
      /<head([^>]*)>/i,
      `<head$1>\n<!-- resume-tailor-company: ${safe} -->`
    );
  }
  return html;
}

/**
 * Apply tailored copy onto template HTML. Layout and CSS stay as in the file; only slotted regions change.
 */
export function applyTailorPointsToTemplate(html: string, points: TailorPointsJson): string {
  const out = injectCompanyHead(html, points.company);

  const doc = parseDoc(out);
  const body = doc.body;
  if (!body) throw new Error('Template has no body.');

  const summaryEl = body.querySelector('[data-resume-slot="summary"]');
  if (summaryEl) summaryEl.textContent = points.summary;

  const bodyEl = body as unknown as HTMLElement;
  for (const sec of points.sections) {
    if (sec.type === 'bullets') {
      const uls = getSortedSectionBlockUls(bodyEl, sec.id);
      for (let i = 0; i < uls.length; i++) {
        setBulletList(uls[i], sec.lists[i] ?? []);
      }
    } else {
      const els = getSortedSkillValueElements(bodyEl, sec.id);
      for (let j = 0; j < els.length; j++) {
        els[j].textContent = sec.values[j] ?? '';
      }
    }
  }

  const root = doc.documentElement;
  if (!root) return out;
  const dt = out.match(/<!DOCTYPE[^>]*>/i)?.[0] ?? '';
  return `${dt}\n${root.outerHTML}`.trim();
}

export { validateResumeSlots };
