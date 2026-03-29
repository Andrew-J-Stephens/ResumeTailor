import { saveResume, getResumeBlob } from './lib/db';
import { normalizeJobDescriptionFromPage } from './lib/jobSelection';
import type { StoredResume } from './lib/types';

const el = (id: string) => document.getElementById(id)!;
const statusEl = el('status');
const fileInput = el('file') as HTMLInputElement;
const currentEl = el('current');
const previewBtn = el('preview') as HTMLButtonElement;
const tailorBtn = el('tailor') as HTMLButtonElement;
const coverLetterBtn = el('cover-letter') as HTMLButtonElement;
const clearBtn = el('clear') as HTMLButtonElement;
const openOptions = el('open-options') as HTMLAnchorElement;

function setStatus(text: string, kind: 'info' | 'error' | 'success' = 'info') {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

async function loadMeta(): Promise<StoredResume | undefined> {
  const res = await chrome.runtime.sendMessage({ type: 'GET_CURRENT_RESUME' });
  return res?.meta as StoredResume | undefined;
}

async function hasApiKey(): Promise<boolean> {
  const { aiProvider, openaiApiKey, anthropicApiKey } = await chrome.storage.local.get([
    'aiProvider',
    'openaiApiKey',
    'anthropicApiKey',
  ]);
  const key = aiProvider === 'anthropic' ? anthropicApiKey : openaiApiKey;
  return typeof key === 'string' && key.trim().length > 0;
}

function renderCurrent(meta: StoredResume | undefined, canTailor: boolean) {
  if (!meta) {
    currentEl.textContent =
      'No resume uploaded. Tailoring uses the built-in template; upload HTML for preview and cover letter.';
    previewBtn.disabled = true;
    tailorBtn.disabled = !canTailor;
    coverLetterBtn.disabled = true;
    clearBtn.disabled = true;
    return;
  }
  const when = new Date(meta.uploadedAt).toLocaleString();
  currentEl.textContent = `${meta.fileName} (${meta.mimeType}) — uploaded ${when}`;
  previewBtn.disabled = false;
  tailorBtn.disabled = !canTailor;
  coverLetterBtn.disabled = false;
  clearBtn.disabled = false;
}

async function refresh() {
  const meta = await loadMeta();
  const canTailor = await hasApiKey();
  renderCurrent(meta, canTailor);
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;

  const mime = (file.type || '').toLowerCase();
  const nameOk = /\.html?$/i.test(file.name);
  const mimeOk =
    mime === 'text/html' ||
    mime === 'application/xhtml+xml' ||
    mime === '' ||
    mime === 'application/octet-stream';
  if (!nameOk && !mimeOk) {
    setStatus('Please upload a .html or .htm file.', 'error');
    return;
  }

  setStatus('Saving…');
  try {
    const prev = await loadMeta();
    if (prev) {
      await chrome.runtime.sendMessage({ type: 'CLEAR_RESUME' });
    }
    const meta = await saveResume(
      file.name,
      mime || 'text/html',
      file
    );
    await chrome.storage.local.set({ currentResume: meta });
    setStatus('Resume saved.', 'success');
    await refresh();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), 'error');
  }
});

previewBtn.addEventListener('click', async () => {
  setStatus('Opening current resume preview…');
  try {
    const meta = await loadMeta();
    if (!meta) {
      setStatus('No resume uploaded yet.', 'error');
      return;
    }
    const blob = await getResumeBlob(meta.id);
    if (!blob) {
      setStatus('Stored resume not found. Please upload again.', 'error');
      return;
    }
    const html = await blob.text();
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    await chrome.tabs.create({ url, active: true });
    setStatus('Opened current resume in a new tab.', 'success');
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), 'error');
  }
});

tailorBtn.addEventListener('click', async () => {
  setStatus('Reading selection from page…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus('No active tab.', 'error');
      return;
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return '';
        return sel.toString();
      },
    });
    const text = normalizeJobDescriptionFromPage(
      String(results[0]?.result ?? '')
    );
    if (!text) {
      setStatus(
        'Highlight the job description on the page, then click again.',
        'error'
      );
      return;
    }
    setStatus('Calling OpenAI and preparing A4 PDF…');
    const result = await chrome.runtime.sendMessage({
      type: 'TAILOR',
      jobDescription: text,
    });
    if (result?.ok) {
      setStatus(`Downloaded: ${result.fileName}`, 'success');
    } else {
      setStatus(result?.error ?? 'Unknown error', 'error');
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), 'error');
  }
});

coverLetterBtn.addEventListener('click', async () => {
  setStatus('Reading selection from page…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus('No active tab.', 'error');
      return;
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return '';
        return sel.toString();
      },
    });
    const text = normalizeJobDescriptionFromPage(
      String(results[0]?.result ?? '')
    );
    if (!text) {
      setStatus(
        'Highlight the job description on the page, then click again.',
        'error'
      );
      return;
    }
    setStatus('Generating cover letter and preparing A4 PDF…');
    const result = await chrome.runtime.sendMessage({
      type: 'TAILOR_COVER_LETTER',
      jobDescription: text,
    });
    if (result?.ok) {
      setStatus(`Downloaded: ${result.fileName}`, 'success');
    } else {
      setStatus(result?.error ?? 'Unknown error', 'error');
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), 'error');
  }
});

clearBtn.addEventListener('click', async () => {
  setStatus('Clearing…');
  await chrome.runtime.sendMessage({ type: 'CLEAR_RESUME' });
  setStatus('Cleared.', 'info');
  await refresh();
});

openOptions.addEventListener('click', (ev) => {
  ev.preventDefault();
  void chrome.runtime.openOptionsPage();
});

void refresh();
