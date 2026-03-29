import BUNDLED_HTML from './lib/resume-template.html';
import {
  assertTailorReady,
  extractResumeBuilderConfigFromImportWithAi,
  readSettings,
} from './lib/openai';
import { extractResumeFileForAiImport } from './lib/resumeFileExtract';
import {
  buildSlottedResumeHtml,
  SAMPLE_RESUME_BUILDER_CONFIG,
  type BuilderListBlock,
  type BuilderRoleBlock,
  type ResumeBuilderConfig,
} from './lib/resumeTemplateGenerator';
import { validateResumeSlots } from './lib/resumeSlots';
import {
  clearStoredResumeTemplate,
  loadResumeTemplateHtml,
  saveResumeTemplateHtml,
} from './lib/templateStorage';

const toolbarStatus = document.getElementById('toolbar-status')!;
const htmlSource = document.getElementById('html-source') as HTMLTextAreaElement;
const previewFrame = document.getElementById('preview-frame') as HTMLIFrameElement;
const slotsDialog = document.getElementById('slots-dialog') as HTMLDialogElement;
const shellEl = document.querySelector('.shell')!;

const expBlocks = document.getElementById('exp-blocks')!;
const projBlocks = document.getElementById('proj-blocks')!;
const awardBlocks = document.getElementById('award-blocks')!;

const FORM_SYNC_MS = 120;
let formSyncTimer: ReturnType<typeof setTimeout> | null = null;

function setToolbarStatus(text: string, kind: 'info' | 'error' | 'success' = 'info') {
  toolbarStatus.textContent = text;
  toolbarStatus.dataset.kind = kind;
}

function validateCurrentHtml(): { ok: boolean; errors: string[] } {
  const html = htmlSource.value.trim();
  if (!html) return { ok: false, errors: ['HTML is empty.'] };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  return validateResumeSlots(body);
}

function updatePreview() {
  previewFrame.srcdoc = htmlSource.value;
}

/** At least one experience slot is required for a valid template; keep preview stable if user removed all roles. */
function normalizeConfigForLivePreview(c: ResumeBuilderConfig): ResumeBuilderConfig {
  if (c.experiences.length > 0) return c;
  return {
    ...c,
    experiences: [{ titleLine: '', bullets: [''] }],
  };
}

function applyFormToHtmlAndPreview(): void {
  const cfg = normalizeConfigForLivePreview(readConfigFromForm());
  htmlSource.value = buildSlottedResumeHtml(cfg);
  updatePreview();
}

function scheduleFormSync(): void {
  if (formSyncTimer) clearTimeout(formSyncTimer);
  formSyncTimer = setTimeout(() => {
    formSyncTimer = null;
    applyFormToHtmlAndPreview();
  }, FORM_SYNC_MS);
}

function readListBlocks(container: HTMLElement, titleSel: string, bulletsSel: string): BuilderListBlock[] {
  return Array.from(container.querySelectorAll('.block')).map((block) => {
    const title = (block.querySelector(titleSel) as HTMLInputElement)?.value ?? '';
    const raw = (block.querySelector(bulletsSel) as HTMLTextAreaElement)?.value ?? '';
    const bullets = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return { titleLine: title.trim(), bullets: bullets.length > 0 ? bullets : [''] };
  });
}

function readExperiences(): BuilderRoleBlock[] {
  return readListBlocks(expBlocks, '.exp-title', '.exp-bullets') as BuilderRoleBlock[];
}

function readProjects(): BuilderListBlock[] {
  return readListBlocks(projBlocks, '.proj-title', '.proj-bullets');
}

function readAwards(): BuilderListBlock[] {
  return readListBlocks(awardBlocks, '.award-title', '.award-bullets');
}

function readConfigFromForm(): ResumeBuilderConfig {
  return {
    name: (document.getElementById('f-name') as HTMLInputElement).value.trim() || 'Your Name',
    tagline: (document.getElementById('f-tagline') as HTMLInputElement).value.trim() || 'Role',
    email: (document.getElementById('f-email') as HTMLInputElement).value.trim() || 'you@example.com',
    summary: (document.getElementById('f-summary') as HTMLTextAreaElement).value.trim() || 'Summary.',
    experiences: readExperiences(),
    projects: readProjects(),
    awards: readAwards(),
    skills: {
      programmingLanguages: (document.getElementById('f-skill-pl') as HTMLInputElement).value.trim(),
      cloudDevOps: (document.getElementById('f-skill-cd') as HTMLInputElement).value.trim(),
      apisDatabases: (document.getElementById('f-skill-ad') as HTMLInputElement).value.trim(),
      testingDeployment: (document.getElementById('f-skill-td') as HTMLInputElement).value.trim(),
    },
  };
}

function appendBlock(
  container: HTMLElement,
  kind: 'exp' | 'proj' | 'award',
  data?: BuilderListBlock | BuilderRoleBlock
): void {
  const titleClass = kind === 'exp' ? 'exp-title' : kind === 'proj' ? 'proj-title' : 'award-title';
  const bulletsClass = kind === 'exp' ? 'exp-bullets' : kind === 'proj' ? 'proj-bullets' : 'award-bullets';
  const label = kind === 'exp' ? 'Role title line' : kind === 'proj' ? 'Project title line' : 'Award title line';
  const div = document.createElement('div');
  div.className = 'block';
  div.innerHTML = `
    <button type="button" class="btn-remove">Remove</button>
    <label>${label}
      <input type="text" class="field-input ${titleClass}" />
    </label>
    <label>Bullets (one per line)
      <textarea class="field-input ${bulletsClass}" rows="5"></textarea>
    </label>
  `;
  const titleInput = div.querySelector(`.${titleClass}`) as HTMLInputElement;
  const bulletsTa = div.querySelector(`.${bulletsClass}`) as HTMLTextAreaElement;
  if (data) {
    titleInput.value = data.titleLine;
    bulletsTa.value = data.bullets.join('\n');
  }
  div.querySelector('.btn-remove')!.addEventListener('click', () => {
    div.remove();
    scheduleFormSync();
  });
  container.appendChild(div);
}

function populateFormFromConfig(c: ResumeBuilderConfig): void {
  (document.getElementById('f-name') as HTMLInputElement).value = c.name;
  (document.getElementById('f-tagline') as HTMLInputElement).value = c.tagline;
  (document.getElementById('f-email') as HTMLInputElement).value = c.email;
  (document.getElementById('f-summary') as HTMLTextAreaElement).value = c.summary;
  (document.getElementById('f-skill-pl') as HTMLInputElement).value = c.skills.programmingLanguages;
  (document.getElementById('f-skill-cd') as HTMLInputElement).value = c.skills.cloudDevOps;
  (document.getElementById('f-skill-ad') as HTMLInputElement).value = c.skills.apisDatabases;
  (document.getElementById('f-skill-td') as HTMLInputElement).value = c.skills.testingDeployment;

  expBlocks.replaceChildren();
  projBlocks.replaceChildren();
  awardBlocks.replaceChildren();
  for (const e of c.experiences) appendBlock(expBlocks, 'exp', e);
  for (const p of c.projects) appendBlock(projBlocks, 'proj', p);
  for (const a of c.awards) appendBlock(awardBlocks, 'award', a);
}

document.getElementById('btn-add-exp')!.addEventListener('click', () => {
  appendBlock(expBlocks, 'exp', { titleLine: '', bullets: [''] });
  scheduleFormSync();
});

document.getElementById('btn-add-proj')!.addEventListener('click', () => {
  appendBlock(projBlocks, 'proj', { titleLine: '', bullets: [''] });
  scheduleFormSync();
});

document.getElementById('btn-add-award')!.addEventListener('click', () => {
  appendBlock(awardBlocks, 'award', { titleLine: '', bullets: [''] });
  scheduleFormSync();
});

document.getElementById('btn-validate')!.addEventListener('click', () => {
  const r = validateCurrentHtml();
  if (r.ok) {
    setToolbarStatus('Template is valid. All required slots are present.', 'success');
  } else {
    setToolbarStatus(r.errors.join(' '), 'error');
  }
});

document.getElementById('btn-save')!.addEventListener('click', async () => {
  const r = validateCurrentHtml();
  if (!r.ok) {
    setToolbarStatus(`Fix errors before saving: ${r.errors.join(' ')}`, 'error');
    return;
  }
  try {
    await saveResumeTemplateHtml(htmlSource.value);
    setToolbarStatus('Saved. Tailor resume and cover letter will use this template.', 'success');
  } catch (e) {
    setToolbarStatus(e instanceof Error ? e.message : String(e), 'error');
  }
});

document.getElementById('btn-preview')!.addEventListener('click', () => {
  updatePreview();
  setToolbarStatus('Preview refreshed from HTML editor.', 'info');
});

document.getElementById('btn-bundled')!.addEventListener('click', async () => {
  await clearStoredResumeTemplate();
  htmlSource.value = BUNDLED_HTML;
  updatePreview();
  setToolbarStatus('Reset to bundled default (saved copy cleared).', 'success');
});

document.getElementById('btn-clear')!.addEventListener('click', async () => {
  await clearStoredResumeTemplate();
  setToolbarStatus(
    'Saved template cleared. Tailoring uses the bundled default until you save again.',
    'success'
  );
});

document.getElementById('btn-regenerate')!.addEventListener('click', () => {
  const cfg = readConfigFromForm();
  if (cfg.experiences.length === 0) {
    setToolbarStatus('Add at least one experience role.', 'error');
    return;
  }
  htmlSource.value = buildSlottedResumeHtml(cfg);
  updatePreview();
  setToolbarStatus('HTML regenerated from the form. Validate and save when ready.', 'success');
});

shellEl.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
  if (t.id === 'html-source') {
    updatePreview();
    return;
  }
  scheduleFormSync();
});

document.getElementById('link-options')!.addEventListener('click', (ev) => {
  ev.preventDefault();
  void chrome.runtime.openOptionsPage();
});

document.getElementById('link-slots')!.addEventListener('click', (ev) => {
  ev.preventDefault();
  slotsDialog.showModal();
});

const resumeImportFile = document.getElementById('resume-import-file') as HTMLInputElement;
resumeImportFile.addEventListener('change', async () => {
  const file = resumeImportFile.files?.[0];
  resumeImportFile.value = '';
  if (!file) return;

  setToolbarStatus('Reading file…');
  try {
    const extracted = await extractResumeFileForAiImport(file);
    const settings = await readSettings();
    assertTailorReady(settings.apiKey);
    setToolbarStatus('Calling your AI model to extract fields…');
    const config = await extractResumeBuilderConfigFromImportWithAi(
      settings,
      extracted.content,
      extracted.contentKind
    );
    populateFormFromConfig(config);
    htmlSource.value = buildSlottedResumeHtml(config);
    updatePreview();
    setToolbarStatus(`Imported “${extracted.fileLabel}” via AI. Review fields, validate, then save if needed.`, 'success');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/api key|Add your API key/i.test(msg)) {
      setToolbarStatus(`${msg} Open extension settings to add your key.`, 'error');
    } else {
      setToolbarStatus(msg, 'error');
    }
  }
});

void (async () => {
  const loaded = await loadResumeTemplateHtml(BUNDLED_HTML);
  htmlSource.value = loaded;
  populateFormFromConfig(SAMPLE_RESUME_BUILDER_CONFIG);
  updatePreview();
})();

export {};
