import { DOMParser } from 'linkedom';

/** Parsed HTML doc from linkedom (types don’t match lib.dom `Document`). */
type HtmlDocLike = {
  readonly head: HTMLElement | null;
  readonly body: HTMLElement | null;
  readonly documentElement: { readonly outerHTML: string } | null;
};

/**
 * Re-apply presentation from the original resume HTML onto the model output.
 * Fixes styling dropped when the model returns JSON (quote-escaping pressure) or rewrites tags.
 * (MV3 service workers have no global DOMParser — use linkedom.)
 */

function copyPresentationAttrs(from: Element, to: Element): void {
  for (const attr of ['style', 'class', 'id'] as const) {
    const v = from.getAttribute(attr);
    if (v !== null && v !== '') to.setAttribute(attr, v);
  }
}

/** Depth-first merge while tag names and child counts match at each step. */
function mergeSubtreePresentation(orig: Element, tail: Element): void {
  if (orig.tagName !== tail.tagName) return;
  copyPresentationAttrs(orig, tail);
  const oc = orig.children;
  const tc = tail.children;
  if (oc.length !== tc.length) return;
  for (let i = 0; i < oc.length; i++) {
    mergeSubtreePresentation(oc[i] as Element, tc[i] as Element);
  }
}

function headHasEquivalent(head: HTMLElement, ref: Element): boolean {
  if (ref.tagName === 'STYLE') {
    const t = ref.textContent?.trim() ?? '';
    for (const s of Array.from(head.querySelectorAll('style'))) {
      if ((s.textContent ?? '').trim() === t) return true;
    }
    return false;
  }
  if (ref.tagName === 'LINK' && ref.getAttribute('rel') === 'stylesheet') {
    const href = ref.getAttribute('href') ?? '';
    for (const l of Array.from(head.querySelectorAll('link[rel="stylesheet"]'))) {
      if ((l.getAttribute('href') ?? '') === href) return true;
    }
    return false;
  }
  return false;
}

/** Append missing <style> and <link rel="stylesheet"> from the original <head>. */
function mergeHeadPresentation(origDoc: HtmlDocLike, tailDoc: HtmlDocLike): void {
  const oh = origDoc.head;
  const th = tailDoc.head;
  if (!oh || !th) return;
  for (const child of Array.from(oh.children)) {
    if (
      child.tagName === 'STYLE' ||
      (child.tagName === 'LINK' && child.getAttribute('rel') === 'stylesheet')
    ) {
      if (!headHasEquivalent(th, child)) {
        th.appendChild(child.cloneNode(true));
      }
    }
  }
}

function serializeHtmlDocument(fallbackSource: string, doc: HtmlDocLike): string {
  const dt = fallbackSource.match(/<!DOCTYPE[^>]*>/i)?.[0] ?? '<!DOCTYPE html>';
  const root = doc.documentElement;
  if (!root) return fallbackSource;
  return `${dt}\n${root.outerHTML}`;
}

/**
 * Prefer original presentation: head CSS + matching subtree style/class/id when structure aligns.
 */
export function mergeResumePresentation(originalHtml: string, tailoredHtml: string): string {
  try {
    const origDoc = new DOMParser().parseFromString(originalHtml, 'text/html') as unknown as HtmlDocLike;
    const tailDoc = new DOMParser().parseFromString(tailoredHtml, 'text/html') as unknown as HtmlDocLike;
    mergeHeadPresentation(origDoc, tailDoc);
    const ob = origDoc.body;
    const tb = tailDoc.body;
    if (ob && tb) mergeSubtreePresentation(ob, tb);
    return serializeHtmlDocument(tailoredHtml, tailDoc);
  } catch {
    return tailoredHtml;
  }
}
