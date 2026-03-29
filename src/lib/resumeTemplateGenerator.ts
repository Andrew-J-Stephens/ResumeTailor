import { SKILL_SLOT_IDS } from './resumeSlots';

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

/** Printable starter resume with all slots the tailor expects. */
export function buildSlottedResumeHtml(c: ResumeBuilderConfig): string {
  const expUls = c.experiences
    .map(
      (e, i) => `
<p class="role-title">${e.titleLine.split('|').map(esc).join('<br>')}</p>
<ul data-resume-slot="experience-${i}">
${e.bullets.map(liFromBullet).join('\n')}
</ul>`
    )
    .join('\n');

  const projUls = c.projects
    .map(
      (p, i) => `
<p class="role-title">${p.titleLine.split('|').map(esc).join('<br>')}</p>
<ul data-resume-slot="project-${i}">
${p.bullets.map(liFromBullet).join('\n')}
</ul>`
    )
    .join('\n');

  const awardUls = c.awards
    .map(
      (a, i) => `
<p class="role-title">${a.titleLine.split('|').map(esc).join('<br>')}</p>
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
    @page { size: A4; margin: 25.4mm; }
    html, body { margin: 0; padding: 0; background: #fff; color: #111; font-family: Arial, Helvetica, sans-serif; }
    body { max-width: 468pt; margin: 0 auto; padding: 48pt 56pt 56pt; box-sizing: border-box; font-size: 11pt; line-height: 1.15; }
    .header { text-align: center; margin-bottom: 10pt; }
    .name { font-size: 17pt; font-weight: 700; margin: 0; }
    .tagline { font-size: 9pt; font-weight: 700; margin: 4pt 0 0; }
    .email { font-size: 9pt; margin: 6pt 0 0; }
    p[data-resume-slot="summary"] { font-size: 9pt; text-align: left; margin: 12pt 0 14pt; }
    .section-title { font-size: 9pt; font-weight: 700; text-decoration: underline; background: #efefef; margin: 14pt 0 6pt; }
    .role-title { font-size: 9pt; font-weight: 700; margin: 10pt 0 4pt; }
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
      titleLine: 'Company, City — Role title    Dates',
      bullets: [
        'Impact-focused bullet with technologies and a measurable outcome.',
        'Second bullet: scope, how you did it, result.',
        'Third bullet: collaboration, scale, or reliability.',
      ],
    },
    {
      titleLine: 'Previous company — Role    Dates',
      bullets: ['Bullet one.', 'Bullet two.'],
    },
  ],
  projects: [
    {
      titleLine: 'Project name — Your role    Dates',
      bullets: ['What you built.', 'Stack and outcome.'],
    },
    {
      titleLine: 'Second project    Date',
      bullets: ['Brief description and technologies.'],
    },
  ],
  awards: [
    { titleLine: 'Award or recognition    Date', bullets: ['One line describing it.'] },
    { titleLine: 'Another award    Date', bullets: ['One line.'] },
  ],
  skills: {
    programmingLanguages: 'Languages and runtimes you want listed.',
    cloudDevOps: 'Cloud and DevOps tools.',
    apisDatabases: 'APIs and data stores.',
    testingDeployment: 'Testing, CI/CD, containers.',
  },
};
