import {
  buildTailoredDownloadFilename,
  buildCoverLetterDownloadFilename,
} from './lib/companyFilename';
import { getResumeBlob, deleteResume } from './lib/db';
import { normalizeJobDescriptionFromPage } from './lib/jobSelection';
import {
  tailorFullHtml,
  readSettings,
  assertReady,
  assertTailorReady,
  generateCoverLetterHtml,
} from './lib/openai';
import type { StoredResume, TailorResult } from './lib/types';

const MENU_ID = 'tailor-selection';
const PRINT_JOB_PREFIX = 'printJob:';

async function getCurrentResumeMeta(): Promise<StoredResume | undefined> {
  const { currentResume } = await chrome.storage.local.get('currentResume');
  return currentResume as StoredResume | undefined;
}

function addA4PrintCss(html: string): string {
  const printCss = `
<style id="resume-tailor-print-a4">
@page { size: A4; margin: 25.4mm 25.4mm; }
html, body {
  margin: 0 !important;
  padding: 0 !important;
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
}
</style>`;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${printCss}`);
  }
  return `<!doctype html><html><head>${printCss}</head><body>${html}</body></html>`;
}

function waitForTabComplete(tabId: number, timeoutMs = 12000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Timed out waiting for PDF render tab to load.'));
    }, timeoutMs);

    function onUpdated(
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ): void {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function debuggerAttach(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function debuggerDetach(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

function debuggerSend<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result as T);
    });
  });
}

async function openPrintPreviewTab(finalHtml: string, fileName: string): Promise<void> {
  const printJobId = crypto.randomUUID();
  await chrome.storage.local.set({
    [`${PRINT_JOB_PREFIX}${printJobId}`]: {
      html: finalHtml,
      fileName,
    },
  });
  const printUrl = chrome.runtime.getURL(`print.html?job=${encodeURIComponent(printJobId)}`);
  await chrome.tabs.create({ url: printUrl, active: true });
}

async function downloadPdfFromHtmlViaCdp(finalHtml: string, fileName: string): Promise<void> {
  const printableHtml = addA4PrintCss(finalHtml);
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(printableHtml)}`;
  const tab = await chrome.tabs.create({ url: dataUrl, active: false });
  if (!tab.id) throw new Error('Could not create temporary tab for PDF rendering.');

  const tabId = tab.id;
  let attached = false;
  try {
    await waitForTabComplete(tabId);
    await debuggerAttach(tabId);
    attached = true;
    await debuggerSend(tabId, 'Page.enable');
    const out = await debuggerSend<{ data?: string }>(tabId, 'Page.printToPDF', {
      printBackground: true,
      paperWidth: 8.27,
      paperHeight: 11.69,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      preferCSSPageSize: true,
    });
    if (!out?.data) {
      throw new Error('PDF generation returned empty data.');
    }
    await chrome.downloads.download({
      url: `data:application/pdf;base64,${out.data}`,
      filename: fileName,
      saveAs: false,
    });
  } finally {
    if (attached) {
      await debuggerDetach(tabId);
    }
    await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

async function runTailor(jobDescription: string): Promise<TailorResult> {
  try {
    const job = normalizeJobDescriptionFromPage(jobDescription);
    if (!job) {
      return { ok: false, error: 'No job description text was provided.' };
    }

    const settings = await readSettings();
    assertTailorReady(settings.apiKey);
    const meta = await getCurrentResumeMeta();

    const tailoredHtml = await tailorFullHtml(
      settings,
      job,
      meta?.fileName ?? 'resume.html'
    );

    const { html: finalHtml, fileName } = buildTailoredDownloadFilename(
      meta!.fileName,
      job,
      tailoredHtml,
      'pdf'
    );
    try {
      await downloadPdfFromHtmlViaCdp(finalHtml, fileName);
    } catch (e) {
      // If debugger-based auto-PDF fails, fall back to visible print preview.
      await openPrintPreviewTab(finalHtml, fileName);
      console.warn(
        'Resume Tailor: auto PDF failed, fell back to print preview.',
        e instanceof Error ? e.message : String(e)
      );
    }

    return { ok: true, fileName };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

async function runCoverLetter(jobDescription: string): Promise<TailorResult> {
  try {
    const job = normalizeJobDescriptionFromPage(jobDescription);
    if (!job) {
      return { ok: false, error: 'No job description text was provided.' };
    }

    const settings = await readSettings();
    const meta = await getCurrentResumeMeta();
    assertReady(meta, settings.apiKey);

    const blob = await getResumeBlob(meta!.id);
    if (!blob) {
      return { ok: false, error: 'Resume file missing from storage. Upload again.' };
    }

    const originalHtml = await blob.text();
    if (!originalHtml.trim()) {
      return { ok: false, error: 'Stored HTML resume is empty.' };
    }

    const coverLetterHtml = await generateCoverLetterHtml(
      settings,
      job,
      originalHtml
    );
    const fileName = buildCoverLetterDownloadFilename(meta!.fileName, job, 'pdf');
    try {
      await downloadPdfFromHtmlViaCdp(coverLetterHtml, fileName);
    } catch (e) {
      await openPrintPreviewTab(coverLetterHtml, fileName);
      console.warn(
        'Resume Tailor: cover letter auto PDF failed, fell back to print preview.',
        e instanceof Error ? e.message : String(e)
      );
    }
    return { ok: true, fileName };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Tailor resume to this selection',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  const text = info.selectionText ?? '';
  if (!normalizeJobDescriptionFromPage(text)) return;
  void runTailor(text).then((result) => {
    if (result.ok) {
      void chrome.action.setBadgeText({ text: '✓' });
      void chrome.action.setBadgeBackgroundColor({ color: '#1b6b2d' });
      setTimeout(() => {
        void chrome.action.setBadgeText({ text: '' });
      }, 2500);
      return;
    }
    void chrome.action.setBadgeText({ text: '!' });
    void chrome.action.setBadgeBackgroundColor({ color: '#c01c28' });
    console.error('Resume Tailor:', result.error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'TAILOR') {
    runTailor(String(message.jobDescription ?? ''))
      .then(sendResponse)
      .catch((e) =>
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        } as TailorResult)
      );
    return true;
  }

  if (message?.type === 'TAILOR_COVER_LETTER') {
    runCoverLetter(String(message.jobDescription ?? ''))
      .then(sendResponse)
      .catch((e) =>
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        } as TailorResult)
      );
    return true;
  }

  if (message?.type === 'GET_CURRENT_RESUME') {
    void getCurrentResumeMeta().then((meta) => sendResponse({ meta }));
    return true;
  }

  if (message?.type === 'CLEAR_RESUME') {
    void (async () => {
      const prev = await getCurrentResumeMeta();
      if (prev) await deleteResume(prev.id);
      await chrome.storage.local.remove(['currentResume']);
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});
