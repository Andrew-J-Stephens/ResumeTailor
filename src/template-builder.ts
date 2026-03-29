import {
  assertTailorReady,
  extractResumeBuilderConfigFromImportWithAi,
  readSettings,
} from './lib/openai';
import { extractResumeFileForAiImport } from './lib/resumeFileExtract';
import { getBundledResumeTemplateHtml } from './lib/resumeTemplateApply';
import {
  buildSlottedResumeHtml,
  SAMPLE_RESUME_BUILDER_CONFIG,
  type BuilderListBlock,
  type ResumeBuilderConfig,
  type ResumeSectionConfig,
  type ResumeSkillsRow,
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
const sectionsRoot = document.getElementById('sections-root')!;

const FORM_SYNC_MS = 120;
let formSyncTimer: ReturnType<typeof setTimeout> | null = null;

function setToolbarStatus(text: string, kind: 'info' | 'error' | 'success' = 'info') {
  toolbarStatus.textContent = text;
  toolbarStatus.dataset.kind = kind;
}

function newSectionId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'u';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]!;
  return s;
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

function normalizeConfigForLivePreview(c: ResumeBuilderConfig): ResumeBuilderConfig {
  const hasBullets = c.sections.some((s) => s.kind === 'bullets' && s.blocks.length > 0);
  if (hasBullets) return c;
  return {
    ...c,
    sections: [
      {
        id: 'experience',
        heading: 'Professional Experience',
        kind: 'bullets',
        blocks: [{ titleLine: '', bullets: [''] }],
      },
      ...c.sections,
    ],
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

function readConfigFromForm(): ResumeBuilderConfig {
  const sections: ResumeSectionConfig[] = [];
  for (const wrap of Array.from(sectionsRoot.querySelectorAll('.section-block')) as HTMLElement[]) {
    let id = wrap.dataset.sectionId?.trim() ?? '';
    if (!id) {
      id = newSectionId();
      wrap.dataset.sectionId = id;
    }
    const heading =
      (wrap.querySelector('.section-heading') as HTMLInputElement)?.value.trim() || 'Section';
    const kind = (wrap.querySelector('.section-kind') as HTMLSelectElement)?.value as
      | 'bullets'
      | 'skills';
    if (kind === 'skills') {
      const rows: ResumeSkillsRow[] = [];
      for (const row of Array.from(wrap.querySelectorAll('.skill-row')) as HTMLElement[]) {
        const label = (row.querySelector('.skill-label') as HTMLInputElement)?.value.trim() ?? '';
        const value = (row.querySelector('.skill-value') as HTMLInputElement)?.value.trim() ?? '';
        rows.push({ label: label || ' ', value: value || ' ' });
      }
      sections.push({
        id,
        heading,
        kind: 'skills',
        rows: rows.length > 0 ? rows : [{ label: ' ', value: ' ' }],
      });
    } else {
      const bulletsHost = wrap.querySelector('.section-bullets') as HTMLElement;
      const blocks = readListBlocks(bulletsHost, '.bullet-title', '.bullet-lines');
      sections.push({ id, heading, kind: 'bullets', blocks });
    }
  }

  return {
    name: (document.getElementById('f-name') as HTMLInputElement).value.trim() || 'Your Name',
    tagline: (document.getElementById('f-tagline') as HTMLInputElement).value.trim() || 'Role',
    email: (document.getElementById('f-email') as HTMLInputElement).value.trim() || 'you@example.com',
    summary: (document.getElementById('f-summary') as HTMLTextAreaElement).value.trim() || 'Summary.',
    sections,
  };
}

function appendBulletBlock(container: HTMLElement, data?: BuilderListBlock): void {
  const div = document.createElement('div');
  div.className = 'block';
  div.innerHTML = `
    <button type="button" class="btn-remove">Remove block</button>
    <label>Title line (role, project, …; optional date at end)
      <input type="text" class="field-input bullet-title" />
    </label>
    <label>Bullets (one per line)
      <textarea class="field-input bullet-lines" rows="5"></textarea>
    </label>
  `;
  const titleInput = div.querySelector('.bullet-title') as HTMLInputElement;
  const bulletsTa = div.querySelector('.bullet-lines') as HTMLTextAreaElement;
  if (data) {
    titleInput.value = data.titleLine;
    bulletsTa.value = data.bullets.join('\n');
  }
  div.querySelector('.btn-remove')!.addEventListener('click', () => {
    const parent = container.querySelectorAll('.block');
    if (parent.length <= 1) return;
    div.remove();
    scheduleFormSync();
  });
  container.appendChild(div);
}

function appendSkillRow(container: HTMLElement, data?: ResumeSkillsRow): void {
  const row = document.createElement('div');
  row.className = 'skill-row';
  row.innerHTML = `
    <button type="button" class="btn-remove btn-remove-skill-row">Remove line</button>
    <label>Label
      <input type="text" class="field-input skill-label" placeholder="e.g. Technical" />
    </label>
    <label>Value
      <input type="text" class="field-input skill-value" />
    </label>
  `;
  if (data) {
    (row.querySelector('.skill-label') as HTMLInputElement).value = data.label;
    (row.querySelector('.skill-value') as HTMLInputElement).value = data.value;
  }
  row.querySelector('.btn-remove-skill-row')!.addEventListener('click', () => {
    if (container.querySelectorAll('.skill-row').length <= 1) return;
    row.remove();
    scheduleFormSync();
  });
  container.appendChild(row);
}

function renderSectionIntoWrapper(wrap: HTMLElement, s: ResumeSectionConfig): void {
  wrap.dataset.sectionId = s.id;
  wrap.innerHTML = `
    <div class="section-block-head">
      <button type="button" class="btn-remove btn-remove-section">Remove section</button>
      <label class="section-heading-wrap">Section title
        <input type="text" class="field-input section-heading" />
      </label>
      <label class="section-kind-wrap">Section type
        <select class="field-input section-kind">
          <option value="bullets">Bulleted blocks (jobs, projects, education, …)</option>
          <option value="skills">Labeled lines (any categories you want)</option>
        </select>
      </label>
    </div>
    <div class="section-bullets blocks"></div>
    <div class="section-skills skill-rows"></div>
    <div class="section-actions">
      <button type="button" class="btn-small btn-add-bullet-block">Add block</button>
      <button type="button" class="btn-small btn-add-skill-row">Add skill line</button>
    </div>
  `;

  (wrap.querySelector('.section-heading') as HTMLInputElement).value = s.heading;
  const kindSel = wrap.querySelector('.section-kind') as HTMLSelectElement;
  kindSel.value = s.kind;

  const bulletsEl = wrap.querySelector('.section-bullets') as HTMLElement;
  const skillsEl = wrap.querySelector('.section-skills') as HTMLElement;
  const btnAddBlock = wrap.querySelector('.btn-add-bullet-block') as HTMLButtonElement;
  const btnAddSkill = wrap.querySelector('.btn-add-skill-row') as HTMLButtonElement;

  function syncKindUi() {
    const k = kindSel.value as 'bullets' | 'skills';
    const isBullets = k === 'bullets';
    bulletsEl.style.display = isBullets ? '' : 'none';
    skillsEl.style.display = isBullets ? 'none' : '';
    btnAddBlock.style.display = isBullets ? '' : 'none';
    btnAddSkill.style.display = isBullets ? 'none' : '';
  }

  if (s.kind === 'bullets') {
    bulletsEl.replaceChildren();
    for (const b of s.blocks) appendBulletBlock(bulletsEl, b);
    skillsEl.replaceChildren();
  } else {
    skillsEl.replaceChildren();
    for (const r of s.rows) appendSkillRow(skillsEl, r);
    bulletsEl.replaceChildren();
  }

  syncKindUi();

  kindSel.addEventListener('change', () => {
    if (kindSel.value === 'bullets') {
      if (bulletsEl.querySelectorAll('.block').length === 0) {
        appendBulletBlock(bulletsEl, { titleLine: '', bullets: [''] });
      }
    } else if (skillsEl.querySelectorAll('.skill-row').length === 0) {
      appendSkillRow(skillsEl, { label: ' ', value: ' ' });
    }
    syncKindUi();
    scheduleFormSync();
  });

  btnAddBlock.addEventListener('click', () => {
    appendBulletBlock(bulletsEl, { titleLine: '', bullets: [''] });
    scheduleFormSync();
  });
  btnAddSkill.addEventListener('click', () => {
    appendSkillRow(skillsEl, { label: '', value: '' });
    scheduleFormSync();
  });

  wrap.querySelector('.btn-remove-section')!.addEventListener('click', () => {
    wrap.remove();
    scheduleFormSync();
  });
}

function appendEmptySection(kind: 'bullets' | 'skills' = 'bullets'): void {
  const wrap = document.createElement('div');
  wrap.className = 'section-block';
  const id = newSectionId();
  if (kind === 'bullets') {
    renderSectionIntoWrapper(wrap, {
      id,
      heading: 'New section',
      kind: 'bullets',
      blocks: [{ titleLine: '', bullets: [''] }],
    });
  } else {
    renderSectionIntoWrapper(wrap, {
      id,
      heading: 'Skills',
      kind: 'skills',
      rows: [{ label: 'Category:', value: '' }],
    });
  }
  sectionsRoot.appendChild(wrap);
}

function populateFormFromConfig(c: ResumeBuilderConfig): void {
  (document.getElementById('f-name') as HTMLInputElement).value = c.name;
  (document.getElementById('f-tagline') as HTMLInputElement).value = c.tagline;
  (document.getElementById('f-email') as HTMLInputElement).value = c.email;
  (document.getElementById('f-summary') as HTMLTextAreaElement).value = c.summary;

  sectionsRoot.replaceChildren();
  for (const s of c.sections) {
    const wrap = document.createElement('div');
    wrap.className = 'section-block';
    renderSectionIntoWrapper(wrap, s);
    sectionsRoot.appendChild(wrap);
  }
}

document.getElementById('btn-add-section')!.addEventListener('click', () => {
  appendEmptySection('bullets');
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
  htmlSource.value = getBundledResumeTemplateHtml();
  updatePreview();
  populateFormFromConfig(SAMPLE_RESUME_BUILDER_CONFIG);
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
  const hasBullets = cfg.sections.some((s) => s.kind === 'bullets' && s.blocks.length > 0);
  if (!hasBullets) {
    setToolbarStatus('Add at least one bulleted section with at least one block.', 'error');
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

shellEl.addEventListener('change', (e) => {
  const t = e.target;
  if (t instanceof HTMLSelectElement && t.classList.contains('section-kind')) {
    scheduleFormSync();
  }
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
  const loaded = await loadResumeTemplateHtml(getBundledResumeTemplateHtml());
  htmlSource.value = loaded;
  populateFormFromConfig(SAMPLE_RESUME_BUILDER_CONFIG);
  updatePreview();
})();

export {};
