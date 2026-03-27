import { mergeResumePresentation } from './htmlMerge';
import { MAX_JOB_DESCRIPTION_CHARS } from './jobSelection';
import type { StoredResume } from './types';

/** Max chars of uploaded resume HTML included in the API prompt (trim tokens vs full file). */
const MAX_RESUME_HTML_CHARS = 24_000;

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

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

function looksLikeHtmlDocument(s: string): boolean {
  const t = s.trim();
  return /^<!DOCTYPE\s+html/i.test(t) || /^<html[\s>]/i.test(t) || /^<body[\s>]/i.test(t);
}

/** If the model adds chatter before the document, take from first <!DOCTYPE / <html / <body. */
function extractHtmlFromProse(s: string): string | null {
  const lower = s.toLowerCase();
  const candidates = ['<!doctype html', '<html', '<body'] as const;
  let best = -1;
  for (const m of candidates) {
    const i = lower.indexOf(m);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  if (best < 0) return null;
  let chunk = stripOuterCodeFences(s.slice(best).trim()).trim();
  // Trailing garbage when message is JSON: ...</html>"}
  chunk = chunk.replace(/"\s*}\s*$/s, '').trim();
  return chunk;
}

/**
 * Parse tailored HTML from assistant message: JSON {"html":"..."}, raw HTML, or HTML after prose.
 */
function parseTailoredHtmlFromAssistant(raw: string): string {
  const trimmed = stripOuterCodeFences(raw).trim();
  if (!trimmed) {
    throw new Error('Empty response from OpenAI.');
  }

  if (looksLikeHtmlDocument(trimmed)) {
    assertLooksLikeHtml(trimmed);
    assertBodyHasVisibleText(trimmed);
    return trimmed;
  }

  const fromProse = extractHtmlFromProse(trimmed);
  if (fromProse && looksLikeHtmlDocument(fromProse)) {
    assertLooksLikeHtml(fromProse);
    assertBodyHasVisibleText(fromProse);
    return fromProse;
  }

  try {
    const parsed = parseAssistantJsonObject(trimmed);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { html?: unknown }).html === 'string') {
      const html = (parsed as { html: string }).html;
      assertLooksLikeHtml(html);
      const out = stripOuterCodeFences(html).trim();
      assertBodyHasVisibleText(out);
      return out;
    }
  } catch {
    /* try fallbacks below */
  }

  // Avoid manual string scan: the first " inside HTML (e.g. class="x") breaks naive readers.
  throw new Error(
    'Could not read the tailored HTML. Ask the model for valid JSON only: {"html":"..."} with every " inside the HTML escaped as \\".'
  );
}

function assertLooksLikeHtml(html: string): void {
  const t = html.trim();
  if (t.length < 40) {
    throw new Error('Tailored HTML is too short. The model may have hit the output limit — try a shorter resume or a model with a larger context.');
  }
  if (!/<html[\s>]/i.test(t) && !/<!DOCTYPE\s+html/i.test(t) && !/<body[\s>]/i.test(t)) {
    throw new Error(
      'Tailored HTML must include a full document (<!DOCTYPE html>, <html>, or <body>).'
    );
  }
}

/** Detect empty or nearly empty visible content (truncated or bad JSON extraction). */
function assertBodyHasVisibleText(html: string): void {
  const noScriptStyle = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const text = noScriptStyle.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 80) {
    throw new Error(
      'The tailored HTML has almost no visible text (empty or nearly empty <body>). This usually means the reply was cut off by the output token limit, or JSON broke on unescaped " in HTML. Use a model with a larger context (e.g. gpt-4o), shorten the source HTML, or ensure the model returns valid JSON with \\" for quotes inside the HTML string.'
    );
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
const MIN_COMPLETION_TOKENS = 2048;
const MAX_COMPLETION_CAP = 16_384;

function buildUserMessage(
  resumeFileName: string,
  jobPart: string,
  htmlPart: string,
  htmlCap: number
): string {
  return [
    `Resume file name: ${resumeFileName}`,
    '',
    'Job description:',
    jobPart,
    '',
    `Original HTML resume (truncated to ${htmlCap} characters if the file is very long):`,
    htmlPart,
    '',
    'Instructions: Reply with the full tailored HTML document only: first character `<` (e.g. <!DOCTYPE html> or <html>), through closing </html>. Do not wrap the document in JSON or markdown. Optimize the entire resume for this job posting—aggressive edits, new bullets where useful (credible for this candidate’s expertise), headline and summary reframed for this role. Use <strong> only for the few most critical role keywords (most lines should have none). Put <!-- resume-tailor-company: Employer Name --> as the first line inside <head> (employer from this job text). Keep every inline style attribute and <style> / stylesheet link from the source so layout and fonts match.',
  ].join('\n');
}

function fitPromptAndCompletionBudget(
  systemContent: string,
  originalHtml: string,
  jobDescription: string,
  resumeFileName: string
): { user: ChatMessage; max_tokens: number } {
  let htmlCap = Math.min(originalHtml.length, MAX_RESUME_HTML_CHARS);
  let jobCap = Math.min(jobDescription.trim().length, MAX_JOB_DESCRIPTION_CHARS);

  for (let i = 0; i < 30; i++) {
    const jobPart = jobDescription.trim().slice(0, jobCap);
    const htmlPart = originalHtml.slice(0, htmlCap);
    const userContent = buildUserMessage(resumeFileName, jobPart, htmlPart, htmlCap);
    const promptTokens = estimateTokensFromChars(systemContent.length + userContent.length);
    const available = ASSUMED_CONTEXT_WINDOW - promptTokens - RESERVED_TOKENS;

    if (available >= MIN_COMPLETION_TOKENS + 200) {
      const max_tokens = Math.max(
        MIN_COMPLETION_TOKENS,
        Math.min(MAX_COMPLETION_CAP, available)
      );
      return {
        user: { role: 'user', content: userContent },
        max_tokens,
      };
    }

    if (htmlCap >= jobCap) {
      htmlCap = Math.max(2000, Math.floor(htmlCap * 0.82));
    } else {
      jobCap = Math.max(1500, Math.floor(jobCap * 0.82));
    }
  }

  const jobPart = jobDescription.trim().slice(0, jobCap);
  const htmlPart = originalHtml.slice(0, htmlCap);
  const userContent = buildUserMessage(resumeFileName, jobPart, htmlPart, htmlCap);
  const promptTokens = estimateTokensFromChars(systemContent.length + userContent.length);
  const available = ASSUMED_CONTEXT_WINDOW - promptTokens - RESERVED_TOKENS;
  if (available < 256) {
    throw new Error(
      'Could not fit the resume and job description. Shorten the HTML file or job description.'
    );
  }
  const max_tokens = Math.max(
    256,
    Math.min(MAX_COMPLETION_CAP, available)
  );
  return {
    user: { role: 'user', content: userContent },
    max_tokens,
  };
}

/**
 * Sends the full original HTML + job description; model returns complete tailored HTML.
 * The extension renders that HTML for A4 print/save to PDF.
 */
export async function tailorFullHtml(
  apiKey: string,
  model: string,
  jobDescription: string,
  originalHtml: string,
  resumeFileName: string
): Promise<string> {
  const system: ChatMessage = {
    role: 'system',
    content: [
      'You are a resume editor. You receive the full HTML of a resume and a job description.',
      '',
      'Purpose (posting-first, aggressive fit):',
      '- Priority is that the resume reads as a near-perfect match for THIS job description: mirror its language, priorities, tech stack, and responsibilities. This should take advantage of how ATS systems search for keywords and phrases.',
      '- Edit sections if helpful, keep all existing bullet point ideas represented (they may be rewritten for clarity and impact). Add bullet points to match the description, expand or replace skills, and reshape the summary so every part of the resume sells the same story the posting asks for.',
      '- You may add new bullets and achievements that are plausible for someone with this background and seniority, even if not spelled out on the source resume, as long as they stay in the candidate’s realistic wheelhouse (same domain, stack, and level). Do not fabricate employers, job titles at real companies, degrees, or date ranges—those must stay consistent with the original.',
      '',
      'Internal reasoning step (do not output):',
      '- Extract the top 10 requirements, technologies, and responsibilities from the job description.',
      '- Map each requirement to at least one bullet, skill, or summary statement in the resume.',
      '- Ensure the most critical requirements appear early in the resume and are reflected in multiple sections when appropriate.',
      '',
      'Technology alignment rule:',
      '- If the job description mentions specific technologies, tools, APIs, frameworks, infrastructure, or platforms (for example Stripe, Kafka, Terraform, Kubernetes, Snowflake, etc.), ensure those technologies appear meaningfully in the resume.',
      '- Do not simply add technologies to the skills list; integrate them into experience bullets whenever possible.',
      '- Technologies from the job description should appear inside real accomplishments and technical descriptions.',
      '',
      'Technology-to-experience mapping:',
      '- When a technology appears in the job description but not in the original resume, you may introduce it into a relevant role’s experience bullets if it would be realistic for someone in that position.',
      '- Add the technology to the role where it logically fits the surrounding responsibilities and tech stack.',
      '- The bullet must describe a concrete implementation (for example integrating an API, building infrastructure, designing a service, or implementing a workflow).',
      '- Always attach a measurable KPI or outcome when introducing a new technology (for example revenue impact, user growth, latency improvement, deployment speed, operational efficiency, or conversion improvement).',
      '- Example pattern: "Integrated Stripe payment processing into the SaaS billing system, enabling subscription payments and increasing checkout conversion by 18%."',
      '',
      'Human screening optimization:',
      '- The resume should read convincingly to a hiring manager in under 10 seconds.',
      '- The top third of the resume should clearly communicate:',
      '  1. Role identity',
      '  2. Core technical strengths or domain expertise',
      '  3. Evidence of impact, scale, or ownership.',
      '',
      'Summary structure:',
      '- Write a concise 2–3 sentence professional summary.',
      '- Include:',
      '  • role identity and years of experience',
      '  • core technologies or domain expertise',
      '  • scale of systems, teams, or impact',
      '  • alignment with the employer’s domain or mission.',
      '',
      'Bullet quality standard (extremely important):',
      '- Rewrite bullets to maximize hiring impact.',
      '- Prefer the structure: [Action verb] + [problem or responsibility] + [how it was executed] + [measurable result].',
      '- Favor quantified outcomes when plausible: %, revenue, latency reduction, time saved, cost savings, user scale, throughput, reliability improvements, etc.',
      '- If the original bullet lacks impact, infer a realistic measurable outcome consistent with the candidate’s experience level.',
      '',
      'Ownership language:',
      '- Favor verbs that signal ownership and leadership such as: designed, built, architected, led, launched, optimized, scaled, implemented, delivered.',
      '- Avoid weak phrasing like: responsible for, helped with, involved in.',
      '',
      'Bullet discipline:',
      '- Each role should contain approximately 3–6 high-quality bullets.',
      '- Prefer fewer high-impact bullets rather than many shallow bullets.',
      '',
      'Technical specificity:',
      '- When referencing technologies, show how they were used (architecture, infrastructure, performance improvements, automation, scale, system design).',
      '- Avoid generic statements that only list tools without describing implementation.',
      '',
      'ATS keyword integration:',
      '- Integrate terminology from the job description naturally inside bullets and descriptions.',
      '- Avoid keyword stuffing or unnatural lists.',
      '- Prefer embedding keywords in real achievements and technical descriptions.',
      '',
      'Skills section:',
      '- Rebuild this section around the posting—lead with must-have tools and exact phrases from the job description.',
      '- Add skills that are standard for this role and credible for the candidate’s background.',
      '- Remove or demote skills that distract from the target role.',
      '',
      'Experience section:',
      '- Tailor each role so bullets directly answer the job description’s requirements.',
      '- Align verbs, tools, and outcomes with the language of the posting where possible.',
      '- You may split, merge, or rewrite bullets to better communicate impact and relevance.',
      '',
      'Role keywords (visual emphasis):',
      '- Optionally use <strong>...</strong> for a very small number of the most important terms for THIS role (for example the primary tech stack or domain keywords).',
      '- Keep bolding rare: most bullets and paragraphs should have no <strong> at all.',
      '',
      'Employer comment (for the app; stripped before the file is saved):',
      '- As the first line inside <head>, include exactly: <!-- resume-tailor-company: Company Name -->',
      '- Infer Company Name from the job description (the hiring employer). Plain text only between the colon and -->; if unclear, use Unknown.',
      '',
      'OUTPUT FORMAT (critical):',
      '- Return ONLY the tailored HTML document itself.',
      '- Do not change font sizes or layout structure.',
      '- First character must be `<` (start with <!DOCTYPE html> or <html>).',
      '- End with </html>.',
      '- No markdown code fences, no JSON wrapper, no commentary before or after the document.',
      '- Raw HTML avoids breaking inline style="..." and CSS that contains double quotes — do not use JSON for the page.',
      '',
      'CRITICAL — body content:',
      '- The <body> must remain a complete resume.',
      '- Every major section from the source should remain (experience, education, skills, etc.).',
      '- Never return an empty <body>, a placeholder-only body, or only a <head> with no real resume text.',
      '',
      'Styling (must match the source visually):',
      '- Keep every inline style attribute from the original on the corresponding elements.',
      '- Do not strip style attributes to simplify markup.',
      '- Preserve all <style>...</style> blocks and <link rel="stylesheet"> tags.',
      '- Preserve class and id attributes so CSS selectors continue to apply.',
      '- You may add or remove <li> bullets and adjust list length where needed for experience.',
      '- When using <strong>, nest it inside existing elements (such as inside <p> or <li>) without removing parent styles.',
      '',
      'Ground rules:',
      '- Keep employers, company names, employment dates, schools, and degree credentials exactly consistent with the original resume.',
      '- Do not invent new employers, job titles at real companies, schools, or time ranges.',
      '- For accomplishments and metrics, prioritize alignment with the job description; plausible specifics are acceptable if they fit the candidate’s level and responsibilities.',
      '- When uncertain, favor strong alignment with the job posting while remaining credible for the candidate’s background.'
    ].join('\n'),
  };

  const { user, max_tokens } = fitPromptAndCompletionBudget(
    system.content,
    originalHtml,
    jobDescription,
    resumeFileName
  );

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens,
      messages: [system, user],
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

  if (choice?.finish_reason === 'length') {
    throw new Error(
      'OpenAI stopped at the output length limit (response truncated). Try a shorter source HTML, or a model with a larger context / higher max output.'
    );
  }

  const parsed = parseTailoredHtmlFromAssistant(raw);
  return mergeResumePresentation(originalHtml, parsed);
}

export async function readSettings(): Promise<{
  apiKey: string;
  model: string;
}> {
  const { openaiApiKey, openaiModel } = await chrome.storage.local.get([
    'openaiApiKey',
    'openaiModel',
  ]);
  return {
    apiKey: typeof openaiApiKey === 'string' ? openaiApiKey : '',
    model: typeof openaiModel === 'string' && openaiModel ? openaiModel : 'gpt-4o-mini',
  };
}

function isHtmlResume(meta: StoredResume): boolean {
  const m = (meta.mimeType ?? '').toLowerCase();
  if (m === 'text/html' || m === 'application/xhtml+xml') return true;
  if (m === '' || m === 'application/octet-stream') {
    return /\.html?$/i.test(meta.fileName);
  }
  return false;
}

export function assertReady(meta: StoredResume | undefined, apiKey: string): void {
  if (!meta) throw new Error('No resume on file. Upload an HTML file in the popup.');
  if (!isHtmlResume(meta)) {
    throw new Error('Upload a .html or .htm resume. Output opens as tailored A4 PDF print preview.');
  }
  if (!apiKey.trim()) throw new Error('Add your OpenAI API key in extension options.');
}
