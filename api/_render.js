// Builds the downloadable files: Word, PDF, Excel and PowerPoint. Input is a spec that has already
// passed normalizeSpec() in _files.js. Nothing here reads files, touches the network, or stores anything.
//
// The heavy libraries are loaded on demand so a PDF request does not pay for Excel, and so
// importing this module stays cheap.

import { marked } from "marked";

// ---------------------------------------------------------------------------
// Markdown helpers shared by Word and PDF
// ---------------------------------------------------------------------------

const safeHref = (href) => (/^(https?:|mailto:)/i.test(String(href || "").trim()) ? String(href).trim() : "");

/** Flatten inline Markdown tokens into styled runs: { text, bold, italic, code, href } or { br: true }. */
function inlineRuns(tokens, style = {}) {
  const out = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case "strong":
        out.push(...inlineRuns(t.tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inlineRuns(t.tokens, { ...style, italic: true }));
        break;
      case "del":
        out.push(...inlineRuns(t.tokens, style));
        break;
      case "codespan":
        out.push({ ...style, text: t.text, code: true });
        break;
      case "link":
        out.push(...inlineRuns(t.tokens, { ...style, href: safeHref(t.href) || undefined }));
        break;
      case "br":
        out.push({ br: true });
        break;
      case "image":
        if (t.text) out.push({ ...style, text: t.text });
        break;
      default:
        if (t.tokens?.length) out.push(...inlineRuns(t.tokens, style));
        else if (t.text || t.raw) out.push({ ...style, text: t.text ?? t.raw });
    }
  }
  return out;
}

const isBlank = (t) => t.type === "space";

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------

export async function renderDocx(spec) {
  const d = await import("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, BorderStyle, LevelFormat, ShadingType, AlignmentType } = d;

  const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  let orderedInstances = 0;

  const children = (tokens, extra = {}) =>
    inlineRuns(tokens).map((r) => {
      if (r.br) return new TextRun({ break: 1 });
      const run = new TextRun({
        text: r.text,
        bold: r.bold || extra.bold,
        italics: r.italic || extra.italics,
        font: r.code ? "Consolas" : undefined,
        color: r.href ? "1155CC" : extra.color,
        underline: r.href ? {} : undefined,
        shading: r.code ? { type: ShadingType.CLEAR, fill: "EEEEEE", color: "auto" } : undefined,
      });
      return r.href ? new ExternalHyperlink({ link: r.href, children: [run] }) : run;
    });

  function blocks(tokens, level = 0, quote = false) {
    const out = [];
    for (const t of tokens) {
      if (isBlank(t)) continue;
      if (t.type === "heading") {
        out.push(new Paragraph({ heading: HEADINGS[Math.min(t.depth, 6) - 1], children: children(t.tokens), spacing: { before: 240, after: 100 } }));
      } else if (t.type === "paragraph" || t.type === "text") {
        out.push(
          new Paragraph({
            children: children(t.tokens || [{ type: "text", text: t.text }], quote ? { italics: true, color: "555555" } : {}),
            spacing: { after: 140 },
            indent: quote ? { left: 480 } : undefined,
            border: quote ? { left: { style: BorderStyle.SINGLE, size: 12, color: "BBBBBB", space: 8 } } : undefined,
          })
        );
      } else if (t.type === "list") {
        const instance = t.ordered ? ++orderedInstances : 0;
        for (const item of t.items) {
          let first = true;
          for (const sub of item.tokens) {
            if (sub.type === "list") {
              out.push(...blocks([sub], level + 1, quote));
            } else if (sub.type === "text" || sub.type === "paragraph") {
              out.push(
                new Paragraph({
                  children: children(sub.tokens || [{ type: "text", text: sub.text }]),
                  numbering: first ? { reference: t.ordered ? "numbered" : "bullets", level: Math.min(level, 3), instance } : undefined,
                  indent: first ? undefined : { left: 720 + level * 360 },
                  spacing: { after: 60 },
                })
              );
              first = false;
            } else {
              out.push(...blocks([sub], level + 1, quote));
            }
          }
        }
      } else if (t.type === "blockquote") {
        out.push(...blocks(t.tokens, level, true));
      } else if (t.type === "code") {
        const lines = String(t.text).split("\n");
        out.push(
          new Paragraph({
            children: lines.flatMap((line, i) => [new TextRun({ text: line, font: "Consolas", size: 20, break: i ? 1 : 0 })]),
            shading: { type: ShadingType.CLEAR, fill: "F3F3F3", color: "auto" },
            spacing: { before: 80, after: 160 },
          })
        );
      } else if (t.type === "hr") {
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "AAAAAA", space: 1 } }, spacing: { before: 120, after: 120 } }));
      } else if (t.type === "table") {
        const cell = (c, header) =>
          new TableCell({
            children: [new Paragraph({ children: children(c.tokens, { bold: header }) })],
            shading: header ? { type: ShadingType.CLEAR, fill: "E8E8E8", color: "auto" } : undefined,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
          });
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [new TableRow({ tableHeader: true, children: t.header.map((c) => cell(c, true)) }), ...t.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) }))],
          }),
          new Paragraph({ spacing: { after: 140 } })
        );
      } else if (t.raw?.trim()) {
        out.push(new Paragraph({ children: [new TextRun({ text: t.raw.trim() })], spacing: { after: 140 } }));
      }
    }
    return out;
  }

  const bulletLevels = [0, 1, 2, 3].map((level) => ({
    level,
    format: LevelFormat.BULLET,
    text: ["•", "◦", "▪", "•"][level],
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
  }));
  const numberLevels = [0, 1, 2, 3].map((level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
  }));

  const doc = new Document({
    creator: "Radiant AI",
    title: spec.title,
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 36, bold: true, color: "1D1A15" }, paragraph: { spacing: { before: 280, after: 120 } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 28, bold: true, color: "1D1A15" }, paragraph: { spacing: { before: 240, after: 100 } } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 24, bold: true, color: "1D1A15" }, paragraph: { spacing: { before: 200, after: 80 } } },
      ],
    },
    numbering: { config: [{ reference: "bullets", levels: bulletLevels }, { reference: "numbered", levels: numberLevels }] },
    sections: [{ children: blocks(marked.lexer(spec.markdown)) }],
  });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const TRANSLIT = { "ɛ": "e", "Ɛ": "E", "ɔ": "o", "Ɔ": "O", "ŋ": "n", "Ŋ": "N", "→": "->", "←": "<-", "✓": "v", "✔": "v", "•": "•" };

export async function renderPdf(spec) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(spec.title);
  pdf.setCreator("Radiant AI");

  const F = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const supported = new Set(F.regular.getCharacterSet());

  /** The built-in PDF fonts only cover Western European text: simplify anything else instead of failing. */
  const clean = (str) =>
    Array.from(String(str).replace(/\t/g, "    ").replace(/ /g, " ")).map((ch) => {
      const cp = ch.codePointAt(0);
      if (cp === 10 || cp === 13) return " ";
      if (supported.has(cp)) return ch;
      if (TRANSLIT[ch]) return TRANSLIT[ch];
      if (cp > 0xffff || cp < 32) return "";
      const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      return base && supported.has(base.codePointAt(0)) ? base : "?";
    }).join("");

  const W = 595.28;
  const H = 841.89;
  const M = 56;
  const BOTTOM = M + 14;
  const INK = rgb(0.11, 0.1, 0.09);
  const MUTED = rgb(0.38, 0.38, 0.38);
  const LINK = rgb(0.07, 0.33, 0.8);

  let page = pdf.addPage([W, H]);
  let y = H - M;
  const ensure = (h) => {
    if (y - h < BOTTOM) {
      page = pdf.addPage([W, H]);
      y = H - M;
    }
  };

  const fontFor = (r) => (r.code ? F.mono : r.bold && r.italic ? F.boldItalic : r.bold ? F.bold : r.italic ? F.italic : F.regular);

  /** Split a word that is wider than a whole line into pieces that each fit. */
  function pieces(text, font, size, maxW) {
    const out = [];
    let rest = text;
    while (rest && font.widthOfTextAtSize(rest, size) > maxW) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxW) cut--;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) out.push(rest);
    return out;
  }

  /** Break styled runs into lines that fit maxW. Each line is a list of { text, font, color, size, width, link }. */
  function wrap(runs, size, maxW, forced = {}) {
    const lines = [[]];
    let width = 0;
    const newLine = () => {
      lines.push([]);
      width = 0;
    };
    for (const r of runs) {
      if (r.br) {
        newLine();
        continue;
      }
      const font = forced.font || fontFor(r);
      const color = forced.color || (r.href ? LINK : INK);
      for (const piece of clean(r.text).split(/(\s+)/)) {
        if (!piece) continue;
        if (/^\s+$/.test(piece)) {
          const w = font.widthOfTextAtSize(" ", size);
          if (width > 0) {
            lines.at(-1).push({ text: " ", font, color, size, width: w });
            width += w;
          }
          continue;
        }
        const parts = pieces(piece, font, size, maxW);
        parts.forEach((text, i) => {
          const w = font.widthOfTextAtSize(text, size);
          if (width > 0 && width + w > maxW) newLine();
          lines.at(-1).push({ text, font, color, size, width: w, link: r.href });
          width += w;
          if (i < parts.length - 1) newLine();
        });
      }
    }
    for (const line of lines) while (line.length && line.at(-1).text === " ") line.pop();
    while (lines.length > 1 && !lines.at(-1).length) lines.pop();
    return lines;
  }

  function drawLines(lines, { x, size, lineHeight, bar }) {
    const step = size * lineHeight;
    for (const line of lines) {
      ensure(step);
      let cx = x;
      for (const seg of line) {
        page.drawText(seg.text, { x: cx, y: y - size, size, font: seg.font, color: seg.color });
        if (seg.link) page.drawLine({ start: { x: cx, y: y - size - 1.5 }, end: { x: cx + seg.width, y: y - size - 1.5 }, thickness: 0.5, color: seg.color });
        cx += seg.width;
      }
      if (bar) page.drawRectangle({ x: x - 10, y: y - step + 2, width: 2.5, height: step, color: rgb(0.75, 0.75, 0.75) });
      y -= step;
    }
  }

  const paragraph = (runs, { size = 11, indent = 0, after = 7, lineHeight = 1.38, bar = false, forced } = {}) => {
    const lines = wrap(runs, size, W - 2 * M - indent, forced);
    drawLines(lines, { x: M + indent, size, lineHeight, bar });
    y -= after;
  };

  const SIZES = [22, 17, 14, 12.5, 11.5, 11];

  function blocks(tokens, level = 0, quote = false) {
    for (const t of tokens) {
      if (isBlank(t)) continue;
      if (t.type === "heading") {
        const size = SIZES[Math.min(t.depth, 6) - 1];
        ensure(size * 1.4 * 3);
        y -= t.depth <= 2 ? 8 : 4;
        paragraph(inlineRuns(t.tokens).map((r) => ({ ...r, bold: true })), { size, after: t.depth <= 2 ? 6 : 3, lineHeight: 1.25 });
      } else if (t.type === "paragraph" || t.type === "text") {
        paragraph(inlineRuns(t.tokens || [{ type: "text", text: t.text }]), quote ? { indent: 16, bar: true, forced: { color: MUTED, font: F.italic } } : {});
      } else if (t.type === "list") {
        let n = Number(t.start) || 1;
        for (const item of t.items) {
          let first = true;
          const indent = 14 + level * 18;
          for (const sub of item.tokens) {
            if (sub.type === "list") {
              blocks([sub], level + 1, quote);
            } else if (sub.type === "text" || sub.type === "paragraph") {
              const lines = wrap(inlineRuns(sub.tokens || [{ type: "text", text: sub.text }]), 11, W - 2 * M - indent - 14);
              ensure(11 * 1.38);
              if (first) {
                const marker = t.ordered ? `${n}.` : "•";
                page.drawText(clean(marker), { x: M + indent, y: y - 11, size: 11, font: F.regular, color: INK });
              }
              drawLines(lines, { x: M + indent + 14, size: 11, lineHeight: 1.38 });
              y -= 3;
              first = false;
            } else {
              blocks([sub], level + 1, quote);
            }
          }
          n++;
        }
        y -= 4;
      } else if (t.type === "blockquote") {
        blocks(t.tokens, level, true);
      } else if (t.type === "code") {
        const size = 9.5;
        const charW = F.mono.widthOfTextAtSize("M", size);
        const per = Math.max(10, Math.floor((W - 2 * M - 16) / charW));
        const rows = [];
        for (const line of t.text.replace(/\r/g, "").split("\n")) {
          const c = clean(line);
          if (!c) rows.push("");
          for (let i = 0; i < c.length; i += per) rows.push(c.slice(i, i + per));
        }
        const step = size * 1.3;
        y -= 2;
        for (const row of rows) {
          ensure(step);
          page.drawRectangle({ x: M, y: y - step + 2, width: W - 2 * M, height: step, color: rgb(0.95, 0.95, 0.95) });
          page.drawText(row, { x: M + 8, y: y - size, size, font: F.mono, color: INK });
          y -= step;
        }
        y -= 9;
      } else if (t.type === "hr") {
        ensure(14);
        y -= 6;
        page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.7, color: rgb(0.7, 0.7, 0.7) });
        y -= 10;
      } else if (t.type === "table") {
        table(t);
      } else if (t.raw?.trim()) {
        paragraph([{ text: t.raw.trim() }]);
      }
    }
  }

  function table(t) {
    const size = 9.5;
    const pad = 4;
    const cols = t.header.length;
    const total = W - 2 * M;
    const weight = t.header.map((h, i) => Math.max(8, Math.min(40, Math.max(String(h.text).length, ...t.rows.map((r) => String(r[i]?.text ?? "").length)))));
    const sum = weight.reduce((a, b) => a + b, 0);
    const widths = weight.map((w) => (w / sum) * total);

    const layout = (cells, header) =>
      cells.map((c, i) => wrap(inlineRuns(c.tokens).map((r) => (header ? { ...r, bold: true } : r)), size, widths[i] - 2 * pad));

    const drawRow = (cells, header) => {
      const lined = layout(cells, header);
      const lineH = size * 1.3;
      const height = Math.max(...lined.map((l) => l.length), 1) * lineH + 2 * pad;
      ensure(height);
      let x = M;
      lined.forEach((lines, i) => {
        page.drawRectangle({ x, y: y - height, width: widths[i], height, borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.6, color: header ? rgb(0.92, 0.92, 0.92) : undefined });
        let cy = y - pad;
        for (const line of lines) {
          let cx = x + pad;
          for (const seg of line) {
            page.drawText(seg.text, { x: cx, y: cy - size, size, font: seg.font, color: seg.color });
            cx += seg.width;
          }
          cy -= lineH;
        }
        x += widths[i];
      });
      y -= height;
    };

    y -= 2;
    drawRow(t.header, true);
    for (const r of t.rows) drawRow(r.length === cols ? r : [...r, ...Array(Math.max(0, cols - r.length)).fill({ tokens: [] })].slice(0, cols), false);
    y -= 10;
  }

  blocks(marked.lexer(spec.markdown));

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: W / 2 - F.regular.widthOfTextAtSize(label, 8.5) / 2, y: M - 22, size: 8.5, font: F.regular, color: MUTED });
  });
  return Buffer.from(await pdf.save());
}

// ---------------------------------------------------------------------------
// Excel (.xlsx)
// ---------------------------------------------------------------------------

// Only these functions are written as live formulas; anything else is stored as plain text.
const SAFE_FUNCTIONS = new Set([
  "SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "ROUND", "ROUNDUP", "ROUNDDOWN", "IF", "IFERROR", "ABS", "MEDIAN",
  "PRODUCT", "SUMIF", "COUNTIF", "AVERAGEIF", "SUMPRODUCT", "AND", "OR", "NOT", "LEN", "UPPER", "LOWER", "TRIM",
  "CONCATENATE", "POWER", "SQRT", "MOD", "INT", "TEXT",
]);

/** Returns the formula body (without "=") if the cell is a simple, safe formula; otherwise null. */
export function safeFormula(value) {
  if (typeof value !== "string" || !value.startsWith("=") || value.length > 500) return null;
  const body = value.slice(1);
  if (!/^[A-Za-z0-9_$.,:;()+\-*/^&<>=% "!']+$/.test(body)) return null;
  const names = [...body.matchAll(/([A-Za-z][A-Za-z0-9.]*)\s*\(/g)].map((m) => m[1].toUpperCase());
  return names.every((n) => SAFE_FUNCTIONS.has(n)) ? body : null;
}

export async function renderXlsx(spec) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Radiant AI";
  wb.title = spec.title;

  for (const sheet of spec.sheets) {
    const ws = wb.addWorksheet(sheet.name);
    const widths = [];
    sheet.rows.forEach((row, r) => {
      const excelRow = ws.getRow(r + 1);
      row.forEach((cell, c) => {
        const formula = safeFormula(cell);
        const target = excelRow.getCell(c + 1);
        // Plain strings stay strings, so a cell like =HYPERLINK(...) is never turned into a live formula.
        target.value = formula ? { formula: formula } : cell;
        const shown = formula ? 10 : String(cell ?? "").length;
        widths[c] = Math.max(widths[c] || 8, Math.min(60, shown + 2));
      });
      excelRow.commit?.();
    });
    widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDE6D6" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// PowerPoint (.pptx)
// ---------------------------------------------------------------------------

export async function renderPptx(spec) {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  pptx.title = spec.title;
  pptx.author = "Radiant AI";

  const INK = "1D1A15";
  const ACCENT = "C28A1D";

  const cover = pptx.addSlide();
  cover.background = { color: "14120F" };
  cover.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.55, w: 1.4, h: 0.07, fill: { color: ACCENT }, line: { color: ACCENT } });
  cover.addText(spec.title, { x: 0.8, y: 1.7, w: 11.7, h: 1.8, fontFace: "Calibri", fontSize: 44, bold: true, color: "EFE9DD", valign: "bottom", fit: "shrink" });

  for (const slide of spec.slides) {
    const s = pptx.addSlide();
    s.background = { color: "FFFFFF" };
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: ACCENT }, line: { color: ACCENT } });
    s.addText(slide.title, { x: 0.8, y: 0.45, w: 11.7, h: 1.0, fontFace: "Calibri", fontSize: 32, bold: true, color: INK, valign: "middle", fit: "shrink" });
    if (slide.bullets.length) {
      s.addText(
        slide.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.8, y: 1.7, w: 11.7, h: 5.2, fontFace: "Calibri", fontSize: 22, color: INK, valign: "top", paraSpaceAfter: 12, fit: "shrink" }
      );
    }
    if (slide.notes) s.addNotes(slide.notes);
  }
  return Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
}

export const renderers = { docx: renderDocx, pdf: renderPdf, xlsx: renderXlsx, pptx: renderPptx };
