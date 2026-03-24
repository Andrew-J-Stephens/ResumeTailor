import {
  AlignmentType,
  CarriageReturn,
  Document,
  FileChild,
  HeadingLevel,
  LevelFormat,
  Paragraph,
  ParagraphChild,
  Packer,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  convertInchesToTwip,
} from 'docx';
import { DOMParser } from 'linkedom';

/** DOM nodeType values — global `Node` is not available in MV3 service workers. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const BULLET_REF = 'resume-tailor-bullet';
const NUMBERED_REF = 'resume-tailor-number';

const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'object',
  'embed',
]);

const HEADING_MAP: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4,
  h5: HeadingLevel.HEADING_5,
  h6: HeadingLevel.HEADING_6,
};

/** Parsed CSS we care about for Word output. */
type ParsedCss = {
  fontWeight?: string;
  fontStyle?: string;
  fontSize?: string;
  color?: string;
  textAlign?: string;
  textDecoration?: string;
  fontFamily?: string;
  marginTop?: string;
  marginBottom?: string;
  marginLeft?: string;
  paddingLeft?: string;
};

type RunStyle = {
  bold?: boolean;
  italics?: boolean;
  underline?: boolean;
  color?: string;
  /** Half-points (docx); e.g. 12pt → 24 */
  sizeHalfPts?: number;
  font?: string;
};

type BlockContext = {
  /** From legacy <center> or outer blocks */
  defaultTextAlign?: (typeof AlignmentType)[keyof typeof AlignmentType];
  /** Inherited inline run style from wrapper elements */
  defaultRunStyle?: RunStyle;
  /** Inherited paragraph spacing defaults (from wrapper element margins). */
  defaultSpacing?: { before?: number; after?: number };
  /** Inherited left indent defaults (from wrapper element padding/margin). */
  defaultIndentLeft?: number;
  /** &lt;th&gt; cell contents default to bold like browsers */
  inTableHeader?: boolean;
};

function parseCssDeclarations(styleAttr: string | null): ParsedCss {
  if (!styleAttr?.trim()) return {};
  const out: ParsedCss = {};
  for (const part of styleAttr.split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    if (key === 'font-weight') out.fontWeight = val;
    else if (key === 'font-style') out.fontStyle = val;
    else if (key === 'font-size') out.fontSize = val;
    else if (key === 'color') out.color = val;
    else if (key === 'text-align') out.textAlign = val;
    else if (key === 'text-decoration') out.textDecoration = val;
    else if (key === 'font-family') out.fontFamily = val;
    else if (key === 'margin-top') out.marginTop = val;
    else if (key === 'margin-bottom') out.marginBottom = val;
    else if (key === 'margin-left') out.marginLeft = val;
    else if (key === 'padding-left') out.paddingLeft = val;
  }
  return out;
}

function mergeParsedCss(base: ParsedCss, override: ParsedCss): ParsedCss {
  return {
    ...base,
    ...override,
    // Keep undefined from overwriting meaningful values; spread already does this,
    // but we normalize so later "unset" doesn't wipe prior values.
    fontWeight: override.fontWeight ?? base.fontWeight,
    fontStyle: override.fontStyle ?? base.fontStyle,
    fontSize: override.fontSize ?? base.fontSize,
    color: override.color ?? base.color,
    textAlign: override.textAlign ?? base.textAlign,
    textDecoration: override.textDecoration ?? base.textDecoration,
    fontFamily: override.fontFamily ?? base.fontFamily,
    marginTop: override.marginTop ?? base.marginTop,
    marginBottom: override.marginBottom ?? base.marginBottom,
    marginLeft: override.marginLeft ?? base.marginLeft,
    paddingLeft: override.paddingLeft ?? base.paddingLeft,
  };
}

function parsedCssToInlineStyleAttr(css: ParsedCss): string {
  // Only emit the properties our converter understands.
  const parts: string[] = [];
  if (css.fontWeight) parts.push(`font-weight:${css.fontWeight}`);
  if (css.fontStyle) parts.push(`font-style:${css.fontStyle}`);
  if (css.fontSize) parts.push(`font-size:${css.fontSize}`);
  if (css.color) parts.push(`color:${css.color}`);
  if (css.textAlign) parts.push(`text-align:${css.textAlign}`);
  if (css.textDecoration) parts.push(`text-decoration:${css.textDecoration}`);
  if (css.fontFamily) parts.push(`font-family:${css.fontFamily}`);
  if (css.marginTop) parts.push(`margin-top:${css.marginTop}`);
  if (css.marginBottom) parts.push(`margin-bottom:${css.marginBottom}`);
  if (css.marginLeft) parts.push(`margin-left:${css.marginLeft}`);
  if (css.paddingLeft) parts.push(`padding-left:${css.paddingLeft}`);
  return parts.join(';');
}

type CssRule = {
  selectors: string[];
  declarations: ParsedCss;
};

function stripCssComments(cssText: string): string {
  return cssText.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Very small CSS parser:
 * - handles `selector { key: value; ... }`
 * - supports comma-separated selectors
 * - ignores @-rules and nested blocks
 *
 * This is intentionally limited, because DOCX can't represent all CSS anyway.
 */
function parseHeadStyleRules(styleText: string): CssRule[] {
  const cleaned = stripCssComments(styleText);
  const rules: CssRule[] = [];

  // Match "something { ... }" blocks. This is naive but works for the resume HTML we target.
  const re = /([^{}@][^{}]*)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(cleaned))) {
    const selectorRaw = m[1].trim();
    const declRaw = m[2].trim();
    if (!selectorRaw || !declRaw) continue;
    // Skip CSS that starts with @ (e.g. @media), since our regex will likely capture junk for it.
    if (selectorRaw.startsWith('@')) continue;
    const selectors = selectorRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (selectors.length === 0) continue;
    const declarations = parseCssDeclarations(declRaw);
    // If rule only contains unsupported properties, parsedCssDeclarations will return {}.
    if (Object.keys(declarations).length === 0) continue;
    rules.push({ selectors, declarations });
  }
  return rules;
}

type HtmlDocLike = {
  head: HTMLElement | null;
  querySelectorAll: (selector: string) => NodeListOf<Element>;
};

/**
 * Apply `<head><style>` CSS to elements by translating matched declarations into each element's
 * inline `style` attribute (so our existing inline-style mapper picks them up).
 *
 * Note: external stylesheets from `<link rel="stylesheet">` aren't fetched here.
 */
function applyHeadStylesToElements(doc: HtmlDocLike): void {
  // Collect ordered rules from all <style> tags.
  const styleTags = Array.from(doc.head?.querySelectorAll('style') ?? []);
  const rules: CssRule[] = [];
  for (const st of styleTags) {
    const t = st.textContent ?? '';
    rules.push(...parseHeadStyleRules(t));
  }
  if (rules.length === 0) return;

  const computedByEl = new Map<Element, ParsedCss>();

  // Apply rules in CSS source order: later rules override earlier ones.
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      try {
        const matches = Array.from(doc.querySelectorAll(selector));
        for (const el of matches) {
          const prev = computedByEl.get(el) ?? {};
          computedByEl.set(el, mergeParsedCss(prev, rule.declarations));
        }
      } catch {
        // Ignore unsupported selectors for our environment.
      }
    }
  }

  // Merge rule-computed styles with existing inline styles (inline wins).
  for (const [el, ruleCss] of computedByEl.entries()) {
    const inline = parseCssDeclarations(el.getAttribute('style'));
    const merged = mergeParsedCss(ruleCss, inline);
    const styleAttr = parsedCssToInlineStyleAttr(merged);
    if (styleAttr.trim()) el.setAttribute('style', styleAttr);
  }
}

/** docx color: 6 hex chars, no # */
function cssColorToDocxHex(raw: string): string | undefined {
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (h.length === 3) return h.split('').map((c) => c + c).join('');
    if (h.length === 6) return h.toUpperCase();
    return undefined;
  }
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    const r = Math.min(255, parseInt(m[1], 10));
    const g = Math.min(255, parseInt(m[2], 10));
    const b = Math.min(255, parseInt(m[3], 10));
    return [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  const named: Record<string, string> = {
    black: '000000',
    white: 'FFFFFF',
    red: 'FF0000',
    green: '008000',
    blue: '0000FF',
    gray: '808080',
    grey: '808080',
  };
  if (named[s]) return named[s];
  return undefined;
}

/** Font size in half-points for docx `size`. */
function parseFontSizeToHalfPts(raw: string): number | undefined {
  const s = raw.trim().toLowerCase();
  const n = parseFloat(s);
  if (Number.isNaN(n) || n <= 0) return undefined;
  if (s.endsWith('pt')) return Math.round(n * 2);
  if (s.endsWith('px')) return Math.round(n * 0.75 * 2);
  if (s.endsWith('em')) return Math.round(n * 11 * 2);
  if (s.endsWith('rem')) return Math.round(n * 16 * 0.75 * 2);
  return Math.round(n * 2);
}

function fontWeightToBold(w?: string): boolean | undefined {
  if (!w) return undefined;
  const x = w.trim().toLowerCase();
  if (x === 'bold' || x === 'bolder') return true;
  if (x === 'normal' || x === 'lighter') return false;
  const num = parseInt(x, 10);
  if (!Number.isNaN(num)) return num >= 600;
  return undefined;
}

function mapTextAlign(
  raw: string | undefined,
  fallback?: (typeof AlignmentType)[keyof typeof AlignmentType]
): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  const a = raw?.trim().toLowerCase();
  if (a === 'center') return AlignmentType.CENTER;
  if (a === 'right') return AlignmentType.RIGHT;
  if (a === 'justify') return AlignmentType.JUSTIFIED;
  if (a === 'left') return AlignmentType.LEFT;
  return fallback;
}

/** Approximate px → twips (96dpi). */
function cssLenToTwips(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const s = raw.trim().toLowerCase();
  const n = parseFloat(s);
  if (Number.isNaN(n)) return undefined;
  if (s.endsWith('pt')) return Math.round(n * 20);
  if (s.endsWith('px')) return Math.round(n * 15);
  if (s.endsWith('in')) return Math.round(n * 1440);
  if (s.endsWith('cm')) return Math.round(n * 567);
  if (s.endsWith('mm')) return Math.round(n * 56.7);
  return Math.round(n * 15);
}

function firstFontFamily(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const part = raw.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? '';
  return part || undefined;
}

function applyCssToRun(base: RunStyle, css: ParsedCss): RunStyle {
  const out: RunStyle = { ...base };
  const fw = fontWeightToBold(css.fontWeight);
  if (fw !== undefined) out.bold = fw;
  if (css.fontStyle?.toLowerCase() === 'italic') out.italics = true;
  if (css.fontStyle?.toLowerCase() === 'normal') out.italics = false;
  const dec = css.textDecoration?.toLowerCase() ?? '';
  if (dec.includes('underline')) out.underline = true;
  if (dec.includes('none')) out.underline = false;
  const hex = css.color ? cssColorToDocxHex(css.color) : undefined;
  if (hex) out.color = hex;
  const sz = css.fontSize ? parseFontSizeToHalfPts(css.fontSize) : undefined;
  if (sz) out.sizeHalfPts = sz;
  const ff = firstFontFamily(css.fontFamily);
  if (ff) out.font = ff;
  return out;
}

function mergeRunStyleFromElement(base: RunStyle, el: Element): RunStyle {
  const tag = el.tagName.toLowerCase();
  let out: RunStyle = { ...base };
  if (tag === 'strong' || tag === 'b') out.bold = true;
  if (tag === 'em' || tag === 'i') out.italics = true;
  if (tag === 'u') out.underline = true;
  const css = parseCssDeclarations(el.getAttribute('style'));
  return applyCssToRun(out, css);
}

function textRunFromStyle(text: string, style: RunStyle): TextRun {
  const opts: {
    text: string;
    bold?: boolean;
    italics?: boolean;
    underline?: { type: (typeof UnderlineType)[keyof typeof UnderlineType] };
    color?: string;
    size?: number;
    font?: string;
  } = { text };
  if (style.bold) opts.bold = true;
  if (style.italics) opts.italics = true;
  if (style.underline) opts.underline = { type: UnderlineType.SINGLE };
  if (style.color) opts.color = style.color;
  if (style.sizeHalfPts) opts.size = style.sizeHalfPts;
  if (style.font) opts.font = style.font;
  return new TextRun(opts);
}

function buildInlineRuns(root: Node, baseStyle: RunStyle = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];

  function walk(n: Node, style: RunStyle): void {
    if (n.nodeType === TEXT_NODE) {
      const t = n.textContent ?? '';
      if (!t) return;
      out.push(textRunFromStyle(t, style));
      return;
    }
    if (n.nodeType !== ELEMENT_NODE) return;
    const el = n as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') {
      out.push(new CarriageReturn());
      return;
    }
    const merged = mergeRunStyleFromElement(style, el);
    if (tag === 'a') {
      for (const c of Array.from(el.childNodes)) walk(c, merged);
      return;
    }
    if (
      tag === 'span' ||
      tag === 'font' ||
      tag === 'code' ||
      tag === 'mark' ||
      tag === 'small' ||
      tag === 'sub' ||
      tag === 'sup'
    ) {
      for (const c of Array.from(el.childNodes)) walk(c, merged);
      return;
    }
    for (const c of Array.from(el.childNodes)) walk(c, merged);
  }

  // Include the root element's own inline style for Word runs.
  // (e.g. `p style="font-size:12pt"` should affect the text inside `p`.)
  let startStyle: RunStyle = { ...baseStyle };
  if (root.nodeType === ELEMENT_NODE) {
    startStyle = mergeRunStyleFromElement(startStyle, root as Element);
  }

  for (const c of Array.from(root.childNodes)) walk(c, startStyle);
  return out;
}

function paragraphBlockProps(
  el: Element,
  ctx: BlockContext
): {
  alignment?: (typeof AlignmentType)[keyof typeof AlignmentType];
  spacing?: { before?: number; after?: number };
  indent?: { left?: number; firstLine?: number };
} {
  const css = parseCssDeclarations(el.getAttribute('style'));
  const align = mapTextAlign(css.textAlign, ctx.defaultTextAlign);
  const spacing: { before?: number; after?: number } = {};
  const mt = cssLenToTwips(css.marginTop);
  const mb = cssLenToTwips(css.marginBottom);
  if (mt !== undefined) spacing.before = mt;
  if (mb !== undefined) spacing.after = mb;
  const indent: { left?: number; firstLine?: number } = {};
  const ml = cssLenToTwips(css.marginLeft);
  const pl = cssLenToTwips(css.paddingLeft);
  if (ml !== undefined) indent.left = ml;
  if (pl !== undefined) indent.left = (indent.left ?? 0) + pl;

  const props: {
    alignment?: (typeof AlignmentType)[keyof typeof AlignmentType];
    spacing?: { before?: number; after?: number };
    indent?: { left?: number; firstLine?: number };
  } = {};
  if (align !== undefined) props.alignment = align;

  // Inherit spacing/indent from wrappers when child elements don't specify them.
  if (ctx.defaultSpacing?.before !== undefined) {
    spacing.before = spacing.before !== undefined ? spacing.before + ctx.defaultSpacing.before : ctx.defaultSpacing.before;
  }
  if (ctx.defaultSpacing?.after !== undefined) {
    spacing.after = spacing.after !== undefined ? spacing.after + ctx.defaultSpacing.after : ctx.defaultSpacing.after;
  }
  if (ctx.defaultIndentLeft !== undefined) {
    indent.left = indent.left !== undefined ? indent.left + ctx.defaultIndentLeft : ctx.defaultIndentLeft;
  }

  if (Object.keys(spacing).length) props.spacing = spacing;
  if (Object.keys(indent).length) props.indent = indent;
  return props;
}

function paragraphFromElement(el: Element, ctx: BlockContext = {}): Paragraph {
  const runs = buildInlineRuns(el, ctx.defaultRunStyle ?? {});
  const block = paragraphBlockProps(el, ctx);
  if (runs.length === 0) {
    return new Paragraph({ text: '\u00a0', ...block });
  }
  return new Paragraph({ children: runs, ...block });
}

function nodeToBlocks(node: Node, ctx: BlockContext = {}): FileChild[] {
  if (node.nodeType === TEXT_NODE) {
    const t = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (!t) return [];
    const inherited = { ...(ctx.defaultRunStyle ?? {}) };
    if (ctx.inTableHeader) inherited.bold = true;

    const spacing: { before?: number; after?: number } = {};
    if (ctx.defaultSpacing?.before !== undefined) spacing.before = ctx.defaultSpacing.before;
    if (ctx.defaultSpacing?.after !== undefined) spacing.after = ctx.defaultSpacing.after;
    const indent: { left?: number } = {};
    if (ctx.defaultIndentLeft !== undefined) indent.left = ctx.defaultIndentLeft;

    return [
      new Paragraph({
        children: [textRunFromStyle(t, inherited)],
        alignment: ctx.defaultTextAlign,
        ...(Object.keys(spacing).length ? { spacing } : null),
        ...(Object.keys(indent).length ? { indent } : null),
      }),
    ];
  }
  if (node.nodeType !== ELEMENT_NODE) return [];
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return [];

  if (tag === 'center') {
    const next: BlockContext = { ...ctx, defaultTextAlign: AlignmentType.CENTER };
    const inner: FileChild[] = [];
    for (const c of Array.from(el.childNodes)) inner.push(...nodeToBlocks(c, next));
    return inner;
  }

  if (
    tag === 'div' ||
    tag === 'section' ||
    tag === 'article' ||
    tag === 'main' ||
    tag === 'header' ||
    tag === 'footer' ||
    tag === 'span'
  ) {
    const inner: FileChild[] = [];

    const divProps = paragraphBlockProps(el, ctx);
    const childRunStyle = mergeRunStyleFromElement(ctx.defaultRunStyle ?? {}, el);
    const childCtx: BlockContext = { ...ctx, defaultRunStyle: childRunStyle };
    if (divProps.alignment !== undefined) childCtx.defaultTextAlign = divProps.alignment;
    if (divProps.spacing) childCtx.defaultSpacing = divProps.spacing;
    if (divProps.indent?.left !== undefined) childCtx.defaultIndentLeft = divProps.indent.left;

    for (const c of Array.from(el.childNodes)) inner.push(...nodeToBlocks(c, childCtx));
    return inner;
  }

  if (tag === 'ul') {
    return listItems(el, false, ctx);
  }
  if (tag === 'ol') {
    return listItems(el, true, ctx);
  }

  if (tag === 'table') {
    const t = tableToDocx(el, ctx);
    return t ? [t] : [];
  }

  if (tag === 'hr') {
    return [new Paragraph({ text: ' ' })];
  }

  if (tag in HEADING_MAP) {
    const runs = buildInlineRuns(el, ctx.defaultRunStyle ?? {});
    const children = runs.length
      ? runs
      : [
          textRunFromStyle(
            el.textContent?.trim() ?? '\u00a0',
            ctx.defaultRunStyle ?? {}
          ),
        ];
    const block = paragraphBlockProps(el, ctx);
    return [
      new Paragraph({
        heading: HEADING_MAP[tag],
        children,
        ...block,
      }),
    ];
  }

  if (tag === 'p' || tag === 'blockquote' || tag === 'pre') {
    return [paragraphFromElement(el, ctx)];
  }

  if (tag === 'li') {
    return [paragraphFromElement(el, ctx)];
  }

  const inner: FileChild[] = [];
  for (const c of Array.from(el.childNodes)) inner.push(...nodeToBlocks(c, ctx));
  return inner;
}

function listItems(list: Element, ordered: boolean, ctx: BlockContext): FileChild[] {
  const ref = ordered ? NUMBERED_REF : BULLET_REF;
  const out: FileChild[] = [];
  for (const li of Array.from(list.querySelectorAll(':scope > li'))) {
    const runs = buildInlineRuns(li, ctx.defaultRunStyle ?? {});
    const block = paragraphBlockProps(li, ctx);
    out.push(
      new Paragraph({
        numbering: { reference: ref, level: 0 },
        ...(runs.length ? { children: runs } : { text: '\u00a0' }),
        ...block,
      })
    );
  }
  return out;
}

function tableToDocx(table: Element, ctx: BlockContext): Table | null {
  const rows: TableRow[] = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells: TableCell[] = [];
    for (const cell of Array.from(tr.querySelectorAll('th, td'))) {
      const ce = cell as Element;
      const isTh = ce.tagName.toLowerCase() === 'th';
      const cellBlocks: FileChild[] = [];
      const cellRunStyle = mergeRunStyleFromElement(ctx.defaultRunStyle ?? {}, ce);
      const cellCtx: BlockContext = { ...ctx, inTableHeader: isTh, defaultRunStyle: cellRunStyle };
      for (const c of Array.from(ce.childNodes)) cellBlocks.push(...nodeToBlocks(c, cellCtx));
      const paragraphs: Paragraph[] = [];
      for (const b of cellBlocks) {
        if (b instanceof Paragraph) paragraphs.push(b);
        else if (b instanceof Table) {
          paragraphs.push(new Paragraph({ text: ce.textContent?.trim() || '\u00a0' }));
        }
      }
      if (paragraphs.length === 0) {
        const raw = ce.textContent?.trim() || '\u00a0';
        paragraphs.push(
          isTh
            ? new Paragraph({ children: [new TextRun({ text: raw, bold: true })] })
            : new Paragraph({ text: raw })
        );
      }
      cells.push(new TableCell({ children: paragraphs }));
    }
    if (cells.length > 0) rows.push(new TableRow({ children: cells }));
  }
  if (rows.length === 0) return null;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
  });
}

function bodyToChildren(body: HTMLElement): FileChild[] {
  const out: FileChild[] = [];
  for (const c of Array.from(body.childNodes)) out.push(...nodeToBlocks(c, {}));
  return out;
}

const numberingConfig = {
  config: [
    {
      reference: BULLET_REF,
      levels: [
        {
          level: 0,
          format: LevelFormat.BULLET,
          text: '\u2022',
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: {
                left: convertInchesToTwip(0.4),
                hanging: convertInchesToTwip(0.2),
              },
            },
          },
        },
      ],
    },
    {
      reference: NUMBERED_REF,
      levels: [
        {
          level: 0,
          format: LevelFormat.DECIMAL,
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: {
                left: convertInchesToTwip(0.4),
                hanging: convertInchesToTwip(0.2),
              },
            },
          },
        },
      ],
    },
  ],
};

/**
 * Convert full HTML document string to a .docx ArrayBuffer (Word-compatible).
 * Uses <body> only; maps common inline `style` and alignment to Word runs/paragraphs.
 */
export async function htmlToDocxArrayBuffer(html: string): Promise<ArrayBuffer> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Apply <head><style> rules so class/id-based styling makes it into Word.
  applyHeadStylesToElements(doc as unknown as HtmlDocLike);
  const body = doc.body;
  let children = bodyToChildren(body);
  if (children.length === 0) {
    children = [new Paragraph({ text: '(empty document)' })];
  }

  const file = new Document({
    numbering: numberingConfig,
    sections: [
      {
        children,
      },
    ],
  });

  return Packer.toArrayBuffer(file);
}
