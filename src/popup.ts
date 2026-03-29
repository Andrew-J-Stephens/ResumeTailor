import { normalizeJobDescriptionFromPage } from './lib/jobSelection';

const el = (id: string) => document.getElementById(id)!;
const statusEl = el('status') as HTMLParagraphElement;
const previewBtn = el('preview') as HTMLButtonElement;
const tailorBtn = el('tailor') as HTMLButtonElement;
const coverLetterBtn = el('cover-letter') as HTMLButtonElement;
const openBuilder = el('open-builder') as HTMLAnchorElement;
const openOptions = el('open-options') as HTMLAnchorElement;

function setStatus(text: string, kind: 'info' | 'error' | 'success' = 'info') {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
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

async function ensureApiKey(): Promise<boolean> {
  if (await hasApiKey()) return true;
  setStatus('Add your API key in extension settings.', 'error');
  return false;
}

previewBtn.addEventListener('click', async () => {
  setStatus('Opening resume preview…');
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'PREVIEW_TEMPLATE' })) as {
      ok?: boolean;
      error?: string;
    };
    if (res?.ok) {
      setStatus('Opened resume in a new tab.', 'success');
    } else {
      setStatus(res?.error ?? 'Could not open preview.', 'error');
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), 'error');
  }
});

tailorBtn.addEventListener('click', async () => {
  if (!(await ensureApiKey())) return;

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
    const text = normalizeJobDescriptionFromPage(String(results[0]?.result ?? ''));
    if (!text) {
      setStatus('Select the job description on the page, then try again.', 'error');
      return;
    }
    setStatus('Tailoring resume…');
    const result = await chrome.runtime.sendMessage({
      type: 'TAILOR',
      jobDescription: text,
    });
    if (result?.ok) {
      setStatus(`Downloaded: ${result.fileName}`, 'success');
    } else {
      setStatus(result?.error ?? 'Something went wrong.', 'error');
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), 'error');
  }
});

coverLetterBtn.addEventListener('click', async () => {
  if (!(await ensureApiKey())) return;

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
    const text = normalizeJobDescriptionFromPage(String(results[0]?.result ?? ''));
    if (!text) {
      setStatus('Select the job description on the page, then try again.', 'error');
      return;
    }
    setStatus('Generating cover letter…');
    const result = await chrome.runtime.sendMessage({
      type: 'TAILOR_COVER_LETTER',
      jobDescription: text,
    });
    if (result?.ok) {
      setStatus(`Downloaded: ${result.fileName}`, 'success');
    } else {
      setStatus(result?.error ?? 'Something went wrong.', 'error');
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), 'error');
  }
});

openBuilder.addEventListener('click', (ev) => {
  ev.preventDefault();
  void chrome.tabs.create({ url: chrome.runtime.getURL('template-builder.html') });
});

openOptions.addEventListener('click', (ev) => {
  ev.preventDefault();
  void chrome.runtime.openOptionsPage();
});

void (async () => {
  const keyOk = await hasApiKey();
  tailorBtn.title = keyOk ? '' : 'Add an API key in extension settings first.';
  coverLetterBtn.title = keyOk ? '' : 'Add an API key in extension settings first.';
})();
