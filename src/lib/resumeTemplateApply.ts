import { DOMParser } from 'linkedom';
import { sanitizeResumeCopyDashes } from './copySanitize';
import BUNDLED_RESUME_TEMPLATE_HTML from './resume-template.html';
import { getSortedUlsBySlotPrefix, SKILL_SLOT_IDS, validateResumeSlots } from './resumeSlots';

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

const SKILL_KEY_BY_SLOT: Record<string, keyof TailorSkillsJson> = {
  'skill-programmingLanguages': 'programmingLanguages',
  'skill-cloudDevOps': 'cloudDevOps',
  'skill-apisDatabases': 'apisDatabases',
  'skill-testingDeployment': 'testingDeployment',
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

/** Shipped default template (before any user save in storage). */
export function getBundledResumeTemplateHtml(): string {
  return BUNDLED_RESUME_TEMPLATE_HTML;
}

function parseDoc(html: string) {
  return new DOMParser().parseFromString(html, 'text/html') as unknown as Document;
}

function listItemPlainTexts(ul: Element): string[] {
  return Array.from(ul.querySelectorAll(':scope > li')).map((li) =>
    (li.textContent ?? '').replace(/\s+/g, ' ').trim()
  );
}

function extractSkillsFromSlots(body: HTMLElement): TailorSkillsJson {
  const out: Partial<TailorSkillsJson> = {};
  for (const slotId of SKILL_SLOT_IDS) {
    const el = body.querySelector(`[data-resume-slot="${slotId}"]`);
    const key = SKILL_KEY_BY_SLOT[slotId];
    if (!el || !key) continue;
    out[key] = (el.textContent ?? '').replace(/^\u00a0\s*/, '').replace(/\s+/g, ' ').trim();
  }
  return {
    programmingLanguages: out.programmingLanguages ?? '',
    cloudDevOps: out.cloudDevOps ?? '',
    apisDatabases: out.apisDatabases ?? '',
    testingDeployment: out.testingDeployment ?? '',
  };
}

/** Plain snapshot of editable copy (for prompts and merge fallbacks). */
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

  const experience = getSortedUlsBySlotPrefix(body, 'experience').map(listItemPlainTexts);
  const projects = getSortedUlsBySlotPrefix(body, 'project').map(listItemPlainTexts);
  const awards = getSortedUlsBySlotPrefix(body, 'award').map(listItemPlainTexts);

  return {
    company: 'Unknown',
    summary,
    experience,
    projects,
    awards,
    skills: extractSkillsFromSlots(bodyEl),
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

  const exp = base.experience.map((fb, i) => normalizeBulletArray(expIn[i], fb.length, fb));
  const proj = base.projects.map((fb, i) => normalizeBulletArray(projIn[i], fb.length, fb));
  const awards = base.awards.map((fb, i) => normalizeBulletArray(awardIn[i], fb.length, fb));

  const skills = normalizeSkills(obj.skills, base.skills);

  return {
    company: sanitizeResumeCopyDashes(company || 'Unknown'),
    summary: sanitizeResumeCopyDashes(summary.length > 0 ? summary : base.summary),
    experience: exp.map((row) => row.map(sanitizeResumeCopyDashes)),
    projects: proj.map((row) => row.map(sanitizeResumeCopyDashes)),
    awards: awards.map((row) => row.map(sanitizeResumeCopyDashes)),
    skills: {
      programmingLanguages: sanitizeResumeCopyDashes(skills.programmingLanguages),
      cloudDevOps: sanitizeResumeCopyDashes(skills.cloudDevOps),
      apisDatabases: sanitizeResumeCopyDashes(skills.apisDatabases),
      testingDeployment: sanitizeResumeCopyDashes(skills.testingDeployment),
    },
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

  const expUls = getSortedUlsBySlotPrefix(body as unknown as HTMLElement, 'experience');
  for (let i = 0; i < expUls.length; i++) {
    setBulletList(expUls[i], points.experience[i] ?? []);
  }

  const projUls = getSortedUlsBySlotPrefix(body as unknown as HTMLElement, 'project');
  for (let i = 0; i < projUls.length; i++) {
    setBulletList(projUls[i], points.projects[i] ?? []);
  }

  const awardUls = getSortedUlsBySlotPrefix(body as unknown as HTMLElement, 'award');
  for (let i = 0; i < awardUls.length; i++) {
    setBulletList(awardUls[i], points.awards[i] ?? []);
  }

  for (const slotId of SKILL_SLOT_IDS) {
    const el = body.querySelector(`[data-resume-slot="${slotId}"]`);
    const key = SKILL_KEY_BY_SLOT[slotId];
    if (el && key) el.textContent = points.skills[key];
  }

  const root = doc.documentElement;
  if (!root) return out;
  const dt = out.match(/<!DOCTYPE[^>]*>/i)?.[0] ?? '';
  return `${dt}\n${root.outerHTML}`.trim();
}

export { validateResumeSlots };
