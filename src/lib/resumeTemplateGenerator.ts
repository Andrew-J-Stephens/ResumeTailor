import { sanitizeResumeCopyDashes } from './copySanitize';
import { SKILL_SLOT_IDS } from './resumeSlots';

const MONTH_GROUP =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December)';

export type BuilderRoleBlock = {
  /** One line above the bullet list (company, title, dates). Plain text; use | for line breaks if needed. */
  titleLine: string;
  bullets: string[];
};

export type BuilderListBlock = {
  titleLine: string;
  bullets: string[];
};

export type ResumeBuilderConfig = {
  name: string;
  tagline: string;
  email: string;
  summary: string;
  experiences: BuilderRoleBlock[];
  projects: BuilderListBlock[];
  awards: BuilderListBlock[];
  skills: {
    programmingLanguages: string;
    cloudDevOps: string;
    apisDatabases: string;
    testingDeployment: string;
  };
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function liFromBullet(b: string): string {
  return `<li>${esc(b)}</li>`;
}

/** Split trailing "Month YYYY … Present|YYYY" off the last segment for right-aligned dates. */
function extractTrailingDateRange(line: string): { main: string; dates: string } {
  const t = line.replace(/\s+/g, ' ').trim();
  if (!t) return { main: '', dates: '' };
  const Mg = MONTH_GROUP;
  const re = new RegExp(
    `\\s+((${Mg}\\s+\\d{4})(?:\\s*[-\\u2013\\u2014]\\s*(?:${Mg}\\s+\\d{4}|Present|present)|\\s+to\\s+(?:${Mg}\\s+\\d{4}|Present|present))?)\\s*$`,
    'i'
  );
  const m = t.match(re);
  if (!m) return { main: t, dates: '' };
  const datesRaw = m[1].trim();
  const main = t.slice(0, m.index).trim();
  return { main, dates: sanitizeResumeCopyDashes(datesRaw) };
}

/** One or more lines (| = line break); last line may end with a date range, shown right-aligned. */
function roleTitleParagraphHtml(raw: string): string {
  const rawLines = raw.split('|').map((l) => l.trim()).filter((l) => l.length > 0);
  if (rawLines.length === 0) return '<p class="role-title"></p>';

  const lastIdx = rawLines.length - 1;
  const lastLine = rawLines[lastIdx]!;
  const { main: lastMain, dates } = extractTrailingDateRange(lastLine);
  const linesBefore = rawLines.slice(0, lastIdx);
  const mainParts = dates ? [...linesBefore, lastMain] : rawLines;
  const mainHtml = mainParts.map(esc).join('<br>');

  if (dates) {
    return `<p class="role-title"><span class="role-title-main">${mainHtml}</span><span class="role-title-dates">${esc(dates)}</span></p>`;
  }
  return `<p class="role-title"><span class="role-title-main">${mainHtml}</span></p>`;
}

/** Printable starter resume with all slots the tailor expects. */
export function buildSlottedResumeHtml(c: ResumeBuilderConfig): string {
  const expUls = c.experiences
    .map(
      (e, i) => `
${roleTitleParagraphHtml(e.titleLine)}
<ul data-resume-slot="experience-${i}">
${e.bullets.map(liFromBullet).join('\n')}
</ul>`
    )
    .join('\n');

  const projUls = c.projects
    .map(
      (p, i) => `
${roleTitleParagraphHtml(p.titleLine)}
<ul data-resume-slot="project-${i}">
${p.bullets.map(liFromBullet).join('\n')}
</ul>`
    )
    .join('\n');

  const awardUls = c.awards
    .map(
      (a, i) => `
${roleTitleParagraphHtml(a.titleLine)}
<ul data-resume-slot="award-${i}">
${a.bullets.map(liFromBullet).join('\n')}
</ul>`
    )
    .join('\n');

  const skillLines = [
    { label: 'Programming Languages:', slot: SKILL_SLOT_IDS[0], value: c.skills.programmingLanguages },
    { label: 'Cloud & DevOps:', slot: SKILL_SLOT_IDS[1], value: c.skills.cloudDevOps },
    { label: 'APIs/Databases:', slot: SKILL_SLOT_IDS[2], value: c.skills.apisDatabases },
    { label: 'Testing & Deployment:', slot: SKILL_SLOT_IDS[3], value: c.skills.testingDeployment },
  ]
    .map(
      (s) =>
        `<p class="skill-line"><strong>${esc(s.label)}</strong> <span data-resume-slot="${s.slot}">${esc(s.value)}</span></p>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Resume</title>
  <style>
    @page { size: A4; margin: 1in; }
    html, body { margin: 0; background: #fff; color: #111; font-family: Arial, Helvetica, sans-serif; }
    /* One inch margins: print uses @page only; screen uses body padding so preview matches. */
    body {
      box-sizing: border-box;
      padding: 0;
      font-size: 11pt;
      line-height: 1.15;
    }
    @media screen {
      body { padding: 1in; }
    }
    .header { text-align: center; margin-bottom: 10pt; }
    .name { font-size: 17pt; font-weight: 700; margin: 0; }
    .tagline { font-size: 9pt; font-weight: 700; margin: 4pt 0 0; }
    .email { font-size: 9pt; margin: 6pt 0 0; }
    p[data-resume-slot="summary"] { font-size: 9pt; text-align: left; margin: 12pt 0 14pt; }
    .section-title { font-size: 9pt; font-weight: 700; text-decoration: underline; background: #efefef; margin: 14pt 0 6pt; }
    .role-title { display: flex; justify-content: space-between; align-items: flex-start; gap: 10pt; font-size: 9pt; font-weight: 700; margin: 10pt 0 4pt; }
    .role-title-main { flex: 1; min-width: 0; text-align: left; }
    .role-title-dates { flex-shrink: 0; text-align: right; white-space: nowrap; font-weight: 700; }
    ul { margin: 0 0 8pt; padding-left: 22pt; }
    li { font-size: 9pt; margin: 0 0 4pt; }
    .skill-line { font-size: 9pt; margin: 0 0 4pt; }
    .skill-line strong { font-weight: 700; }
  </style>
</head>
<body>
  <header class="header">
    <p class="name">${esc(c.name)}</p>
    <p class="tagline">${c.tagline.split('|').map(esc).join('<br>')}</p>
    <p class="email">${esc(c.email)}</p>
  </header>
  <p data-resume-slot="summary">${esc(c.summary)}</p>
  <p class="section-title">Professional Experience</p>
${expUls}
  <p class="section-title">Projects</p>
${projUls}
  <p class="section-title">Awards</p>
${awardUls}
  <p class="section-title">Skills</p>
${skillLines}
</body>
</html>`;
}

export const SAMPLE_RESUME_BUILDER_CONFIG: ResumeBuilderConfig = {
  name: 'Your Name',
  tagline: 'Role | Credential',
  email: 'you@example.com',
  summary:
    'Two or three sentences about your focus, stack, and what you are looking for. The AI will rewrite this for each job.',
  experiences: [
    {
      titleLine: 'Company, City, Role title May 2023 to Present',
      bullets: [
        'Impact-focused bullet with technologies and a measurable outcome.',
        'Second bullet: scope, how you did it, result.',
        'Third bullet: collaboration, scale, or reliability.',
      ],
    },
    {
      titleLine: 'Previous company, Role Jan 2020 to Aug 2022',
      bullets: ['Bullet one.', 'Bullet two.'],
    },
  ],
  projects: [
    {
      titleLine: 'Project name, Your role July 2022 to Dec 2023',
      bullets: ['What you built.', 'Stack and outcome.'],
    },
    {
      titleLine: 'Second project Apr 2022',
      bullets: ['Brief description and technologies.'],
    },
  ],
  awards: [
    { titleLine: 'Award or recognition May 2022', bullets: ['One line describing it.'] },
    { titleLine: 'Another award Mar 2019', bullets: ['One line.'] },
  ],
  skills: {
    programmingLanguages: 'Languages and runtimes you want listed.',
    cloudDevOps: 'Cloud and DevOps tools.',
    apisDatabases: 'APIs and data stores.',
    testingDeployment: 'Testing, CI/CD, containers.',
  },
};
