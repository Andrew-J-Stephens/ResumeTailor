const statusEl = document.getElementById('status') as HTMLDivElement;
const iframeEl = document.getElementById('preview') as HTMLIFrameElement;

const PRINT_JOB_PREFIX = 'printJob:';

function setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
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

async function run(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const jobId = params.get('job');
  if (!jobId) {
    setStatus('Missing print job id.', 'error');
    return;
  }

  const key = `${PRINT_JOB_PREFIX}${jobId}`;
  const data = await chrome.storage.local.get(key);
  const entry = data[key] as { html?: string; fileName?: string } | undefined;
  if (!entry?.html || !entry?.fileName) {
    setStatus('Print job not found or expired.', 'error');
    return;
  }

  document.title = entry.fileName;
  const srcdoc = addA4PrintCss(entry.html);

  iframeEl.addEventListener(
    'load',
    () => {
      setStatus('Opening print dialog…');
      const w = iframeEl.contentWindow;
      if (!w) {
        setStatus('Could not access preview frame.', 'error');
        return;
      }
      w.focus();
      w.print();
      // Cleanup one-time print payload.
      void chrome.storage.local.remove(key);
    },
    { once: true }
  );

  iframeEl.srcdoc = srcdoc;
}

void run().catch((e) => {
  setStatus(e instanceof Error ? e.message : String(e), 'error');
});
