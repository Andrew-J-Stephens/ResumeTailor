import { DOMParser } from 'linkedom';
import RESUME_TEMPLATE from './resume-template.html';

/** Google-Docs-export list classes — must match `resume-template.html`. */
const EXP_UL = ['ul.lst-kix_k868nd227eqx-0', 'ul.lst-kix_d42rme9lxv3b-0'] as const;
const PROJ_UL = ['ul.lst-kix_dw8qa08m9qzg-0', 'ul.lst-kix_ypwe4fqorrtc-0'] as const;
const AWARD_UL = ['ul.lst-kix_hk1kvu7fw4qk-0', 'ul.lst-kix_q18e28yjicuv-0'] as const;

const SKILL_LABELS = [
  { key: 'programmingLanguages' as const, includes: 'Programming Languages' },
  { key: 'cloudDevOps' as const, includes: 'Cloud & DevOps' },
  { key: 'apisDatabases' as const, includes: 'APIs/Databases' },
  { key: 'testingDeployment' as const, includes: 'Testing & Deployment' },
] as const;

export type TailorSkillsJson = {
  programmingLanguages: string;
  cloudDevOps: string;
  apisDatabases: string;
  testingDeployment: string;
};

export type TailorPointsJson = {
  company: string;
  summary: string;
  experience: string[][];
  projects: string[][];
  awards: string[][];
  skills: TailorSkillsJson;
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

export function getResumeTemplateHtml(): string {
  return RESUME_TEMPLATE;
}

function parseDoc(html: string) {
  return new DOMParser().parseFromString(html, 'text/html') as unknown as {
    body: HTMLElement | null;
  };
}

function findSummarySpan(body: HTMLElement): HTMLElement | null {
  const prof = Array.from(body.querySelectorAll('p')).find((p) =>
    (p.textContent ?? '').includes('Professional Experience')
  );
  if (!prof) return null;
  let el: Element | null = prof;
  while (el) {
    el = el.previousElementSibling;
    if (!el) break;
    if (el.tagName !== 'P' || !el.classList.contains('c2') || el.classList.contains('c5')) {
      continue;
    }
    const s = el.querySelector(':scope > span.c3');
    const t = s?.textContent?.trim() ?? '';
    if (s && t.length > 40) return s as HTMLElement;
  }
  return null;
}

function listItemPlainTexts(ul: Element): string[] {
  return Array.from(ul.querySelectorAll(':scope > li')).map((li) =>
    (li.textContent ?? '').replace(/\s+/g, ' ').trim()
  );
}

function collectBySelectors(body: HTMLElement, selectors: readonly string[]): string[][] {
  return selectors.map((sel) => {
    const ul = body.querySelector(sel);
    if (!ul) throw new Error(`Template missing list: ${sel}`);
    return listItemPlainTexts(ul);
  });
}

function extractSkills(body: HTMLElement): TailorSkillsJson {
  const out: Record<string, string> = {};
  for (const { key, includes } of SKILL_LABELS) {
    let found = '';
    for (const p of Array.from(body.querySelectorAll('p.c2'))) {
      const lab = p.querySelector('span.c7');
      const val = p.querySelector('span.c3');
      if (!lab || !val) continue;
      if (!(lab.textContent ?? '').includes(includes)) continue;
      found = (val.textContent ?? '').replace(/^\u00a0\s*/, '').trim();
      break;
    }
    out[key] = found;
  }
  return out as TailorSkillsJson;
}

/** Plain snapshot of editable copy (for prompts and merge fallbacks). */
export function extractTailorSnapshot(html: string): TailorPointsJson {
  const doc = parseDoc(html);
  const body = doc.body;
  if (!body) throw new Error('Template has no body.');

  const summaryEl = findSummarySpan(body);
  const summary = (summaryEl?.textContent ?? '').replace(/\s+/g, ' ').trim();

  return {
    company: 'Unknown',
    summary,
    experience: collectBySelectors(body, EXP_UL),
    projects: collectBySelectors(body, PROJ_UL),
    awards: collectBySelectors(body, AWARD_UL),
    skills: extractSkills(body),
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

function normalizeSkills(incoming: unknown, fallback: TailorSkillsJson): TailorSkillsJson {
  const o = incoming && typeof incoming === 'object' ? (incoming as Record<string, unknown>) : {};
  const pick = (k: keyof TailorSkillsJson): string => {
    const v = o[k];
    const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    return t.length > 0 ? t : fallback[k];
  };
  return {
    programmingLanguages: pick('programmingLanguages'),
    cloudDevOps: pick('cloudDevOps'),
    apisDatabases: pick('apisDatabases'),
    testingDeployment: pick('testingDeployment'),
  };
}

function stripOuterCodeFences(s: string): string {
  let h = s.trim();
  if (h.startsWith('```')) {
    h = h.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/s, '').trim();
  }
  return h;
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

  const expIn = Array.isArray(obj.experience) ? obj.experience : [];
  const projIn = Array.isArray(obj.projects) ? obj.projects : [];
  const awardIn = Array.isArray(obj.awards) ? obj.awards : [];

  const exp = base.experience.map((fb, i) =>
    normalizeBulletArray(expIn[i], fb.length, fb)
  );
  const proj = base.projects.map((fb, i) =>
    normalizeBulletArray(projIn[i], fb.length, fb)
  );
  const awards = base.awards.map((fb, i) =>
    normalizeBulletArray(awardIn[i], fb.length, fb)
  );

  return {
    company: company || 'Unknown',
    summary: summary.length > 0 ? summary : base.summary,
    experience: exp,
    projects: proj,
    awards,
    skills: normalizeSkills(obj.skills, base.skills),
  };
}

function setBulletList(ul: Element, texts: string[]): void {
  const lis = Array.from(ul.querySelectorAll(':scope > li'));
  if (lis.length !== texts.length) {
    throw new Error(`Template bullet count mismatch: expected ${lis.length}, got ${texts.length}.`);
  }
  for (let i = 0; i < lis.length; i++) {
    lis[i].innerHTML = `<span class="c3">${escapeHtml(texts[i] ?? '')}</span>`;
  }
}

function setSkills(body: HTMLElement, skills: TailorSkillsJson): void {
  for (const { key, includes } of SKILL_LABELS) {
    for (const p of Array.from(body.querySelectorAll('p.c2'))) {
      const lab = p.querySelector('span.c7');
      const val = p.querySelector('span.c3');
      if (!lab || !val) continue;
      if (!(lab.textContent ?? '').includes(includes)) continue;
      val.textContent = `\u00a0${skills[key]}`;
      break;
    }
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
 * Apply tailored copy onto the fixed template HTML. Layout, classes, and CSS are unchanged.
 */
export function applyTailorPointsToTemplate(html: string, points: TailorPointsJson): string {
  const out = injectCompanyHead(html, points.company);

  const doc = new DOMParser().parseFromString(out, 'text/html') as unknown as Document;
  const body = doc.body;
  if (!body) throw new Error('Template has no body.');

  const summaryEl = findSummarySpan(body);
  if (summaryEl) summaryEl.textContent = points.summary;

  for (let i = 0; i < EXP_UL.length; i++) {
    const ul = body.querySelector(EXP_UL[i]);
    if (!ul) throw new Error(`Missing ${EXP_UL[i]}`);
    setBulletList(ul, points.experience[i] ?? []);
  }
  for (let i = 0; i < PROJ_UL.length; i++) {
    const ul = body.querySelector(PROJ_UL[i]);
    if (!ul) throw new Error(`Missing ${PROJ_UL[i]}`);
    setBulletList(ul, points.projects[i] ?? []);
  }
  for (let i = 0; i < AWARD_UL.length; i++) {
    const ul = body.querySelector(AWARD_UL[i]);
    if (!ul) throw new Error(`Missing ${AWARD_UL[i]}`);
    setBulletList(ul, points.awards[i] ?? []);
  }

  setSkills(body, points.skills);

  const root = doc.documentElement;
  if (!root) return out;
  const dt = out.match(/<!DOCTYPE[^>]*>/i)?.[0] ?? '';
  return `${dt}\n${root.outerHTML}`.trim();
}
