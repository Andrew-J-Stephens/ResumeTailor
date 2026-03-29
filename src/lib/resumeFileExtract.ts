import mammoth from 'mammoth';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

export type ResumeImportContentKind = 'html' | 'plain_text';

export type ExtractedResumeForImport = {
  fileLabel: string;
  content: string;
  contentKind: ResumeImportContentKind;
};

let pdfWorkerConfigured = false;

function configurePdfWorker(): void {
  if (pdfWorkerConfigured) return;
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.getURL !== 'function') {
    throw new Error('PDF import must run inside the extension (open Template builder from Resume Tailor).');
  }
  GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');
  pdfWorkerConfigured = true;
}

function textFromPageTextContent(items: TextItem[]): string {
  const withPos = items
    .filter((it) => typeof it.str === 'string' && it.str.length > 0)
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
    }));
  withPos.sort((a, b) => {
    if (Math.abs(a.y - b.y) > 3) return b.y - a.y;
    return a.x - b.x;
  });
  return withPos.map((p) => p.str).join(' ');
}

async function extractPdfPlainText(data: ArrayBuffer): Promise<string> {
  configurePdfWorker();
  const pdf = await getDocument({ data: new Uint8Array(data) }).promise;
  const parts: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const strings = tc.items.filter((it): it is TextItem => 'str' in it);
    const line = textFromPageTextContent(strings);
    if (line.trim()) parts.push(line.trim());
  }
  return parts.join('\n\n');
}

/**
 * Reads a resume file locally and returns content suitable for AI import (HTML or plain text).
 */
export async function extractResumeFileForAiImport(file: File): Promise<ExtractedResumeForImport> {
  const fileLabel = file.name || 'resume';
  const lower = fileLabel.toLowerCase();
  const mime = (file.type || '').toLowerCase();

  if (lower.endsWith('.pdf') || mime === 'application/pdf') {
    const buf = await file.arrayBuffer();
    const text = await extractPdfPlainText(buf);
    if (!text.trim()) {
      throw new Error(
        'No text could be extracted from this PDF. Use a PDF with selectable text, or export to HTML or DOCX.'
      );
    }
    return { fileLabel, content: text, contentKind: 'plain_text' };
  }

  if (
    lower.endsWith('.docx') ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const buf = await file.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    const html = (result.value ?? '').trim();
    if (!html) {
      throw new Error('Could not read this DOCX file or it has no content.');
    }
    return { fileLabel, content: html, contentKind: 'html' };
  }

  const htmlByExtension = lower.endsWith('.html') || lower.endsWith('.htm');
  const htmlByMime =
    mime === 'text/html' ||
    mime === 'application/xhtml+xml' ||
    mime === '' ||
    mime === 'application/octet-stream';

  if (htmlByExtension || htmlByMime) {
    const raw = await file.text();
    if (!raw.trim()) {
      throw new Error('That file is empty.');
    }
    if (raw.includes('\0')) {
      throw new Error('This file does not look like HTML. Choose a .html, .pdf, or .docx resume.');
    }
    return { fileLabel, content: raw, contentKind: 'html' };
  }

  throw new Error('Unsupported file type. Use .html, .pdf, or .docx.');
}
