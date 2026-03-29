import { sanitizeResumeCopyDashes } from './copySanitize';
import {
  applyTailorPointsToTemplate,
  extractTailorSnapshot,
  getBundledResumeTemplateHtml,
  parseTailorPointsFromAssistant,
} from './resumeTemplateApply';
import { MAX_JOB_DESCRIPTION_CHARS } from './jobSelection';
import type { ResumeBuilderConfig } from './resumeTemplateGenerator';
import { SAMPLE_RESUME_BUILDER_CONFIG } from './resumeTemplateGenerator';
import { loadResumeTemplateHtml } from './templateStorage';

/** Max chars of bundled resume HTML included in the cover-letter API prompt. */
const MAX_RESUME_HTML_CHARS = 24_000;

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type AiProvider = 'openai' | 'anthropic';

export type AiSettings = {
  provider: AiProvider;
  apiKey: string;
  model: string;
};

function stripOuterCodeFences(s: string): string {
  let h = s.trim();
  if (h.startsWith('```')) {
    h = h.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/s, '').trim();
  }
  return h;
}

/** First top-level `{ ... }` in JSON text (respects strings so `{` inside HTML values is ignored). */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse JSON from models that may wrap output in ```json fences or add prose around the object. */
function parseAssistantJsonObject(raw: string): unknown {
  const s = stripOuterCodeFences(raw.trim());
  try {
    return JSON.parse(s);
  } catch {
    const extracted = extractFirstJsonObject(s);
    if (!extracted) {
      throw new Error('OpenAI did not return a JSON object.');
    }
    return JSON.parse(extracted);
  }
}

/** Conservative token estimate (no tokenizer in the extension). */
function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(charCount / 3);
}

/**
 * Assume a large context window so completion budget is not starved (8192 total was
 * truncating full HTML). The API still enforces the real model limit.
 */
const ASSUMED_CONTEXT_WINDOW = 128_000;
const RESERVED_TOKENS = 256;
const MIN_COMPLETION_POINTS = 2048;
const MAX_COMPLETION_POINTS = 8192;

function buildPointsUserMessage(
  resumeFileName: string,
  jobPart: string,
  snapshotJson: string
): string {
  return [
    `Resume file name (for downloads only): ${resumeFileName}`,
    '',
    'Job description:',
    jobPart,
    '',
    'Current resume content as JSON. Tailor wording only; keep the same array lengths and nesting.',
    snapshotJson,
    '',
    'Reply with a single JSON object only (no markdown fences, no commentary). Keys:',
    '- "company": hiring employer from the job text, or "Unknown".',
    '- "summary": plain text, 2-4 sentences.',
    '- "experience": [ [ bullets for role 1 ], [ bullets for role 2 ] ] — same string counts as input.',
    '- "projects": [ [...], [...] ] — same counts as input.',
    '- "awards": [ [...], [...] ] — same counts as input.',
    '- "skills": { "programmingLanguages", "cloudDevOps", "apisDatabases", "testingDeployment" } — plain strings, no HTML.',
    '',
    'Rules: Do not emit HTML. Do not change employers, role titles, dates, schools, or degree lines (fixed in the document). Mirror job keywords in bullets and skills. Plausible metrics are OK.',
    'Do not use hyphens, en dashes, or em dashes as phrase separators; use commas, and use the word "to" for ranges when needed.',
    'Keep the same number of top-level arrays for experience, projects, and awards as in the input, and the same bullet count inside each (use empty strings only to mean “keep prior wording” for that bullet).',
  ].join('\n');
}

function fitPointsPromptBudget(
  systemContent: string,
  jobDescription: string,
  snapshotJson: string,
  resumeFileName: string
): { user: ChatMessage; max_tokens: number } {
  let jobCap = Math.min(jobDescription.trim().length, MAX_JOB_DESCRIPTION_CHARS);

  for (let i = 0; i < 30; i++) {
    const jobPart = jobDescription.trim().slice(0, jobCap);
    const userContent = buildPointsUserMessage(resumeFileName, jobPart, snapshotJson);
    const promptTokens = estimateTokensFromChars(systemContent.length + userContent.length);
    const available = ASSUMED_CONTEXT_WINDOW - promptTokens - RESERVED_TOKENS;

    if (available >= MIN_COMPLETION_POINTS + 200) {
      const max_tokens = Math.max(
        MIN_COMPLETION_POINTS,
        Math.min(MAX_COMPLETION_POINTS, available)
      );
      return {
        user: { role: 'user', content: userContent },
        max_tokens,
      };
    }

    jobCap = Math.max(1500, Math.floor(jobCap * 0.82));
  }

  const jobPart = jobDescription.trim().slice(0, jobCap);
  const userContent = buildPointsUserMessage(resumeFileName, jobPart, snapshotJson);
  const promptTokens = estimateTokensFromChars(systemContent.length + userContent.length);
  const available = ASSUMED_CONTEXT_WINDOW - promptTokens - RESERVED_TOKENS;
  if (available < 256) {
    throw new Error(
      'Could not fit the job description and resume snapshot. Shorten the job selection.'
    );
  }
  const max_tokens = Math.max(256, Math.min(MAX_COMPLETION_POINTS, available));
  return {
    user: { role: 'user', content: userContent },
    max_tokens,
  };
}

async function callAiChat(
  settings: AiSettings,
  systemContent: string,
  userContent: string,
  maxTokens: number,
  temperature: number
): Promise<{ content: string; finishReason?: string }> {
  if (settings.provider === 'anthropic') {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: settings.model,
        system: systemContent,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: 'user', content: [{ type: 'text', text: userContent }] }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic error ${res.status}: ${errText.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      content?: { type?: string; text?: string }[];
      stop_reason?: string;
    };
    const text = (data.content ?? [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();
    if (!text) throw new Error('Empty response from Anthropic');
    return { content: text, finishReason: data.stop_reason };
  }

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: {
      message?: { content?: string };
      finish_reason?: string;
    }[];
  };
  const choice = data.choices?.[0];
  const raw = choice?.message?.content;
  if (!raw) throw new Error('Empty response from OpenAI');
  return { content: raw, finishReason: choice?.finish_reason };
}

const MAX_TEMPLATE_IMPORT_HTML_CHARS = 24_000;
const TEMPLATE_IMPORT_MAX_TOKENS = 8192;

function normalizeListBlockFromAi(x: unknown): { titleLine: string; bullets: string[] } | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const titleLine = typeof o.titleLine === 'string' ? o.titleLine.replace(/\s+/g, ' ').trim() : '';
  if (!Array.isArray(o.bullets)) return { titleLine, bullets: [''] };
  const bullets = o.bullets
    .map((b) => (typeof b === 'string' ? b.replace(/\s+/g, ' ').trim() : ''))
    .filter((b) => b.length > 0);
  return { titleLine, bullets: bullets.length > 0 ? bullets : [''] };
}

function normalizeAiResumeBuilderConfig(parsed: unknown): ResumeBuilderConfig {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI did not return a JSON object for the resume import.');
  }
  const o = parsed as Record<string, unknown>;

  const str = (key: string, fallback: string) =>
    typeof o[key] === 'string' ? (o[key] as string).replace(/\s+/g, ' ').trim() : fallback;

  let experiences: ResumeBuilderConfig['experiences'] = [];
  if (Array.isArray(o.experiences)) {
    for (const item of o.experiences) {
      const b = normalizeListBlockFromAi(item);
      if (b) experiences.push(b);
    }
  }
  if (experiences.length === 0) {
    throw new Error('AI response had no experiences. Try again or use a clearer HTML resume.');
  }

  const mapList = (key: string): ResumeBuilderConfig['projects'] => {
    const out: ResumeBuilderConfig['projects'] = [];
    if (!Array.isArray(o[key])) return out;
    for (const item of o[key]) {
      const b = normalizeListBlockFromAi(item);
      if (b) out.push(b);
    }
    return out;
  };

  const projects = mapList('projects');
  const awards = mapList('awards');

  let skillsIn = o.skills;
  const skillsBase = SAMPLE_RESUME_BUILDER_CONFIG.skills;
  if (!skillsIn || typeof skillsIn !== 'object') skillsIn = {};
  const sk = skillsIn as Record<string, unknown>;
  const skillStr = (k: keyof typeof skillsBase) =>
    typeof sk[k] === 'string' ? (sk[k] as string).replace(/\s+/g, ' ').trim() : skillsBase[k];

  const raw: ResumeBuilderConfig = {
    name: str('name', 'Your Name') || 'Your Name',
    tagline: str('tagline', 'Role') || 'Role',
    email: str('email', 'you@example.com') || 'you@example.com',
    summary: str('summary', SAMPLE_RESUME_BUILDER_CONFIG.summary),
    experiences,
    projects,
    awards,
    skills: {
      programmingLanguages: skillStr('programmingLanguages'),
      cloudDevOps: skillStr('cloudDevOps'),
      apisDatabases: skillStr('apisDatabases'),
      testingDeployment: skillStr('testingDeployment'),
    },
  };

  return {
    ...raw,
    email: raw.email.replace(/\s+/g, ' ').trim(),
    name: sanitizeResumeCopyDashes(raw.name),
    tagline: sanitizeResumeCopyDashes(raw.tagline),
    summary: sanitizeResumeCopyDashes(raw.summary),
    experiences: raw.experiences.map((e) => ({
      titleLine: sanitizeResumeCopyDashes(e.titleLine),
      bullets: e.bullets.map(sanitizeResumeCopyDashes),
    })),
    projects: raw.projects.map((p) => ({
      titleLine: sanitizeResumeCopyDashes(p.titleLine),
      bullets: p.bullets.map(sanitizeResumeCopyDashes),
    })),
    awards: raw.awards.map((a) => ({
      titleLine: sanitizeResumeCopyDashes(a.titleLine),
      bullets: a.bullets.map(sanitizeResumeCopyDashes),
    })),
    skills: {
      programmingLanguages: sanitizeResumeCopyDashes(raw.skills.programmingLanguages),
      cloudDevOps: sanitizeResumeCopyDashes(raw.skills.cloudDevOps),
      apisDatabases: sanitizeResumeCopyDashes(raw.skills.apisDatabases),
      testingDeployment: sanitizeResumeCopyDashes(raw.skills.testingDeployment),
    },
  };
}

export type ResumeImportPromptKind = 'html' | 'plain_text';

/**
 * Reads resume content (HTML or plain text from PDF) and returns fields for the template builder.
 */
export async function extractResumeBuilderConfigFromImportWithAi(
  settings: AiSettings,
  content: string,
  contentKind: ResumeImportPromptKind
): Promise<ResumeBuilderConfig> {
  assertTailorReady(settings.apiKey);
  const trimmed = content.trim();
  if (!trimmed) throw new Error('Resume content is empty.');

  const body = trimmed.slice(0, MAX_TEMPLATE_IMPORT_HTML_CHARS);
  const truncatedNote =
    trimmed.length > MAX_TEMPLATE_IMPORT_HTML_CHARS
      ? `\n\n(Note: only the first ${MAX_TEMPLATE_IMPORT_HTML_CHARS} characters were sent.)`
      : '';

  const sourceNote =
    contentKind === 'html'
      ? 'Input may be HTML (or HTML converted from DOCX). Ignore scripts, styles, and chrome; use visible text and structure only.'
      : 'Input is plain text extracted from a PDF; reading order or columns may not match the printed page. Infer roles, bullets, and dates from what is readable.';

  const systemContent = [
    'You extract structured resume content for a template builder inside a browser extension.',
    'Return a single JSON object only (no markdown fences, no commentary before or after).',
    '',
    'Exact JSON shape:',
    '{',
    '  "name": string,',
    '  "tagline": string, one line; you may use " | " between short phrases (e.g. role | credential),',
    '  "email": string,',
    '  "summary": string, 2–5 sentences, plain text,',
    '  "experiences": [ { "titleLine": string, "bullets": string[] }, ... ],',
    '  "projects": [ { "titleLine": string, "bullets": string[] }, ... ],',
    '  "awards": [ { "titleLine": string, "bullets": string[] }, ... ],',
    '  "skills": {',
    '    "programmingLanguages": string,',
    '    "cloudDevOps": string,',
    '    "apisDatabases": string,',
    '    "testingDeployment": string',
    '  }',
    '}',
    '',
    'Rules:',
    `- ${sourceNote}`,
    '- Do not invent employers, schools, degrees, or date ranges that are not clearly supported by the document.',
    '- At least one experience object with at least one non-empty bullet.',
    '- titleLine for each role/project/award: one plain-text line, no HTML tags in output. Separate company, place, role, and dates with commas (not hyphens or dashes). Put the date range last using "Month YYYY to Month YYYY" or "Month YYYY to Present" (the word "to", never a dash).',
    '- bullets: achievement lines only; strip leading bullets or punctuation used as list markers.',
    '- In every string: no en dashes, em dashes, or spaced hyphens as separators; use commas or "to" for ranges.',
    '- projects and awards may be empty arrays if the resume has none.',
    '- skills: split or phrase naturally; values only (labels are fixed elsewhere).',
  ].join('\n');

  const userLabel =
    contentKind === 'html'
      ? 'Resume content (HTML):'
      : 'Resume content (plain text from PDF):';

  const userContent = [userLabel, body, truncatedNote].join('\n');

  const out = await callAiChat(
    settings,
    systemContent,
    userContent,
    TEMPLATE_IMPORT_MAX_TOKENS,
    0.2
  );
  if (out.finishReason === 'length' || out.finishReason === 'max_tokens') {
    throw new Error(
      'AI response was truncated. Try a shorter resume file or a model with a higher max output.'
    );
  }

  return normalizeAiResumeBuilderConfig(parseAssistantJsonObject(out.content));
}

/**
 * Uses the bundled HTML template for layout/CSS; the model returns JSON copy only.
 * The extension applies text into the template for A4 print/save to PDF.
 */
export async function tailorFullHtml(
  settings: AiSettings,
  jobDescription: string,
  resumeFileName: string
): Promise<string> {
  const template = await loadResumeTemplateHtml(getBundledResumeTemplateHtml());
  const base = extractTailorSnapshot(template);
  const snapshotJson = JSON.stringify(base);

  const system: ChatMessage = {
    role: 'system',
    content: [
      'You tailor resume copy to a job posting. Output is JSON only; the app injects text into the user’s HTML template using data-resume-slot markers (you never write HTML).',
      '',
      'Goals: Strong ATS and human match—mirror the posting’s language, stack, and responsibilities. Integrate keywords naturally in bullets and skills.',
      'Keep employers, job titles at real companies, employment dates, schools, and degrees consistent with the input JSON (do not rename companies or change date strings).',
      'Rewrite bullets for impact: action verb + scope + how + measurable outcome when plausible. Prefer ownership verbs (built, shipped, led, designed). Weave job-specific technologies into experience bullets where credible.',
      'Rebuild skills strings around the posting; lead with must-haves from the job text.',
      'The "company" field is the hiring employer name for filenames (or Unknown).',
      'Do not use hyphens, en dashes, or em dashes as phrase separators (commas are fine; use the word "to" for ranges when needed).',
    ].join('\n'),
  };

  const { user, max_tokens } = fitPointsPromptBudget(
    system.content,
    jobDescription,
    snapshotJson,
    resumeFileName
  );

  const out = await callAiChat(settings, system.content, user.content, max_tokens, 0.3);
  if (out.finishReason === 'length' || out.finishReason === 'max_tokens') {
    throw new Error(
      'AI stopped at the output length limit. Try a shorter job selection or a model with a higher max output.'
    );
  }

  const points = parseTailorPointsFromAssistant(out.content, base);
  return applyTailorPointsToTemplate(template, points);
}

type CoverLetterDraft = {
  fullName: string;
  targetRole: string;
  company: string;
  greeting: string;
  paragraphs: string[];
  closingLine: string;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toSafeLine(text: string, fallback: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function toSafeParagraphs(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''))
    .filter((v) => v.length > 0);
}

function buildStandardCoverLetterHtml(draft: CoverLetterDraft): string {
  const today = new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const paragraphs = draft.paragraphs.slice(0, 4);
  const body = paragraphs
    .map((p) => `<p class="body">${escapeHtml(p)}</p>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cover Letter - ${escapeHtml(draft.fullName)}</title>
  <style>
    @page { size: A4; margin: 1in; }
    html, body { margin: 0; background: #fff; color: #111; }
    body {
      font-family: "Times New Roman", Times, serif;
      font-size: 12pt;
      line-height: 1.5;
      box-sizing: border-box;
      padding: 0;
    }
    @media screen {
      body { padding: 1in; }
    }
    .doc { max-width: 680px; margin: 0 auto; }
    .date, .company, .greeting, .closing { margin: 0 0 14px; }
    .body { margin: 0 0 12px; text-align: left; }
    .name { margin: 0; font-weight: 700; }
  </style>
</head>
<body>
  <div class="doc">
    <p class="date">${escapeHtml(today)}</p>
    <p class="company">Hiring Manager<br>${escapeHtml(draft.company)}<br>${escapeHtml(draft.targetRole)} Role</p>
    <p class="greeting">${escapeHtml(draft.greeting)}</p>
    ${body}
    <p class="closing">${escapeHtml(draft.closingLine)}</p>
    <p class="name">${escapeHtml(draft.fullName)}</p>
  </div>
</body>
</html>`;
}

export async function generateCoverLetterHtml(
  settings: AiSettings,
  jobDescription: string
): Promise<string> {
  const originalResumeHtml = await loadResumeTemplateHtml(getBundledResumeTemplateHtml());
  const system: ChatMessage = {
    role: 'system',
    content: [
      'You are an expert cover letter writer.',
      'Given a job description and the candidate resume (HTML excerpt below), produce JSON only with this exact schema:',
      '{"fullName":"...","targetRole":"...","company":"...","greeting":"...","paragraphs":["...","...","..."],"closingLine":"..."}',
      'Rules:',
      '- 3 paragraphs in "paragraphs", each 2-4 sentences.',
      '- Keep claims credible to the candidate background.',
      '- Make it specific to the role and job posting language.',
      '- Use professional, concise tone.',
      '- No markdown, no extra keys, JSON only.',
      '- If company is unknown, set "company" to "Hiring Team".',
      '- If full name is unknown, infer from resume heading; fallback "Candidate".',
      '- greeting should be "Dear Hiring Manager," unless a specific recipient is clearly present.',
      '- closingLine should be "Sincerely,".',
    ].join('\n'),
  };

  const resumePart = originalResumeHtml.slice(0, MAX_RESUME_HTML_CHARS);
  const jobPart = jobDescription.trim().slice(0, MAX_JOB_DESCRIPTION_CHARS);
  const user: ChatMessage = {
    role: 'user',
    content: [
      'Job description:',
      jobPart,
      '',
      `Resume HTML (first ${MAX_RESUME_HTML_CHARS} chars):`,
      resumePart,
    ].join('\n'),
  };

  const out = await callAiChat(settings, system.content, user.content, 1200, 0.4);
  if (out.finishReason === 'length' || out.finishReason === 'max_tokens') {
    throw new Error('Cover letter generation was truncated. Please retry.');
  }

  const parsed = parseAssistantJsonObject(out.content) as Partial<CoverLetterDraft>;
  const draft: CoverLetterDraft = {
    fullName: toSafeLine(String(parsed.fullName ?? ''), 'Candidate'),
    targetRole: toSafeLine(String(parsed.targetRole ?? ''), 'Target Role'),
    company: toSafeLine(String(parsed.company ?? ''), 'Hiring Team'),
    greeting: toSafeLine(String(parsed.greeting ?? ''), 'Dear Hiring Manager,'),
    paragraphs: (() => {
      const p = toSafeParagraphs(parsed.paragraphs);
      if (p.length >= 3) return p.slice(0, 3);
      return [
        'I am excited to apply for this role. My background aligns strongly with the technical requirements and delivery expectations in your posting.',
        'Across my recent work, I have built and improved production systems with measurable impact, including reliability, performance, and delivery speed improvements.',
        'I would welcome the opportunity to contribute to your team and help deliver high-quality outcomes quickly and collaboratively.',
      ];
    })(),
    closingLine: toSafeLine(String(parsed.closingLine ?? ''), 'Sincerely,'),
  };

  return buildStandardCoverLetterHtml(draft);
}

export async function readSettings(): Promise<AiSettings> {
  const { aiProvider, openaiApiKey, anthropicApiKey, openaiModel, anthropicModel } =
    await chrome.storage.local.get([
      'aiProvider',
      'openaiApiKey',
      'anthropicApiKey',
      'openaiModel',
      'anthropicModel',
    ]);
  const provider: AiProvider = aiProvider === 'anthropic' ? 'anthropic' : 'openai';
  if (provider === 'anthropic') {
    return {
      provider,
      apiKey: typeof anthropicApiKey === 'string' ? anthropicApiKey : '',
      model:
        typeof anthropicModel === 'string' && anthropicModel
          ? anthropicModel
          : 'claude-sonnet-4-5',
    };
  }
  return {
    provider,
    apiKey: typeof openaiApiKey === 'string' ? openaiApiKey : '',
    model: typeof openaiModel === 'string' && openaiModel ? openaiModel : 'gpt-4o-mini',
  };
}

export function assertTailorReady(apiKey: string): void {
  if (!apiKey.trim()) throw new Error('Add your API key in extension settings.');
}
