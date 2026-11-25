// Downloadable documents: validation, the model's "prepare a file" tools, and request detection.
//
// Nothing is stored. The model describes a file as a small spec (title plus Markdown, rows, or
// slides). The chat page shows a file card, and when you press a button it sends the spec to
// /api/export, which builds the Word / PDF / Excel / PowerPoint file and returns it.
//
// This module is light on purpose (no document libraries); the heavy rendering is in _render.js.

export const FORMATS = {
  docx: { type: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  pdf: { type: "document", mime: "application/pdf" },
  xlsx: { type: "spreadsheet", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { type: "presentation", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};

/** Which download buttons a file card of each type offers. */
export const FORMATS_BY_TYPE = { document: ["docx", "pdf"], spreadsheet: ["xlsx"], presentation: ["pptx"] };

const LIMITS = {
  title: 120,
  markdown: 60_000,
  sheets: 5,
  rows: 1000,
  cols: 50,
  cell: 2000,
  slides: 30,
  bullets: 12,
  bullet: 300,
  notes: 1000,
};

export class FileSpecError extends Error {}

// Side-notes a chat model tacks on after an answer ("how to save this as a PDF", "press the Download
// button", "all facts verified against cited sources"). They are not part of a document, so a reply that
// is exported as one loses them.
const CHATTER =
  /(save (this|the|it)\b[^.\n]{0,40}\bas a (pdf|word)|press the download button|download button under|how to save|export as pdf|print\s*(\u2192|->)\s*save as pdf|paste (it |them |this )?(in|into) (any |a |your )?(markdown|google doc|word)|copy the entire content|file generation|base64|make this a pdf|all facts verified|no unverified claims|verified against (the )?cited)/i;
const isRule = (block) => /^\s*([-*_]\s*){3,}\s*$/.test(block);

/** Remove trailing chat side-notes (and the rules above them) from Markdown meant to become a document. */
export function stripChatter(markdown) {
  const blocks = String(markdown).split(/\n{2,}/);
  let end = blocks.length;
  while (end > 1 && (isRule(blocks[end - 1]) || CHATTER.test(blocks[end - 1]))) end--;
  while (end > 1 && isRule(blocks[end - 1])) end--;
  if (end === blocks.length) return markdown;
  const kept = blocks.slice(0, end).join("\n\n");
  // Safety net: never throw away most of a document because of a keyword.
  return kept.trim().length >= markdown.trim().length * 0.4 ? kept : markdown;
}

const text = (value, max) => String(value ?? "").replace(/\r\n?/g, "\n").slice(0, max);

function cleanTitle(title, fallback) {
  const t = text(title, LIMITS.title).replace(/\s+/g, " ").trim();
  return t || fallback;
}

/** Check a file spec from the model or the browser and return a clean copy. Throws FileSpecError. */
export function normalizeSpec(spec) {
  if (!spec || typeof spec !== "object") throw new FileSpecError("Missing file content.");

  if (spec.type === "document") {
    const raw = text(spec.markdown, LIMITS.markdown + 1);
    if (!raw.trim()) throw new FileSpecError("The document is empty.");
    if (raw.length > LIMITS.markdown) throw new FileSpecError(`The document is too long (max ${LIMITS.markdown} characters).`);
    return { type: "document", title: cleanTitle(spec.title, "Document"), markdown: stripChatter(raw) };
  }

  if (spec.type === "spreadsheet") {
    const raw = Array.isArray(spec.sheets) && spec.sheets.length ? spec.sheets : [{ name: spec.sheet_name, rows: spec.rows }];
    if (raw.length > LIMITS.sheets) throw new FileSpecError(`Too many sheets (max ${LIMITS.sheets}).`);
    const sheets = raw.map((sheet, i) => {
      const rows = sheet?.rows;
      if (!Array.isArray(rows) || !rows.length) throw new FileSpecError("A spreadsheet needs at least one row.");
      if (rows.length > LIMITS.rows) throw new FileSpecError(`Too many rows (max ${LIMITS.rows}).`);
      const clean = rows.map((row) => {
        if (!Array.isArray(row) || row.length > LIMITS.cols) throw new FileSpecError(`Each row must be a list of at most ${LIMITS.cols} cells.`);
        return row.map((cell) => (typeof cell === "number" && Number.isFinite(cell) ? cell : typeof cell === "boolean" ? cell : text(cell, LIMITS.cell)));
      });
      const name = text(sheet?.name, 31).replace(/[\\/?*[\]:]/g, " ").trim() || `Sheet${i + 1}`;
      return { name, rows: clean };
    });
    return { type: "spreadsheet", title: cleanTitle(spec.title, "Spreadsheet"), sheets };
  }

  if (spec.type === "presentation") {
    if (!Array.isArray(spec.slides) || !spec.slides.length) throw new FileSpecError("A presentation needs at least one slide.");
    if (spec.slides.length > LIMITS.slides) throw new FileSpecError(`Too many slides (max ${LIMITS.slides}).`);
    const slides = spec.slides.map((slide, i) => ({
      title: text(slide?.title, 200).trim() || `Slide ${i + 1}`,
      bullets: (Array.isArray(slide?.bullets) ? slide.bullets : []).slice(0, LIMITS.bullets).map((b) => text(b, LIMITS.bullet)),
      notes: text(slide?.notes, LIMITS.notes),
    }));
    return { type: "presentation", title: cleanTitle(spec.title, "Presentation"), slides };
  }

  throw new FileSpecError("Unknown file type.");
}

/** A safe download file name: ASCII letters, digits and dashes. */
export function fileName(title, format) {
  const base = String(title || "document")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "document"}.${format}`;
}

// ---------------------------------------------------------------------------
// Tools offered to the model
// ---------------------------------------------------------------------------

const CARD_TYPES = {
  prepare_document: "document",
  prepare_spreadsheet: "spreadsheet",
  prepare_presentation: "presentation",
};

export const fileToolNames = Object.keys(CARD_TYPES);

export const fileToolDefinitions = [
  {
    type: "function",
    function: {
      name: "prepare_document",
      description:
        "Prepare a downloadable document (the user gets Word and PDF buttons). Use it whenever the user asks you to draft, write or create a document such as a letter, CV, report, proposal, memo or contract. Write the complete document in Markdown (headings, lists, tables, bold, links).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Document title; also used as the file name." },
          content_markdown: { type: "string", description: "The complete document in Markdown." },
        },
        required: ["title", "content_markdown"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_spreadsheet",
      description:
        "Prepare a downloadable Excel spreadsheet. rows is a list of rows, each a list of cell values; put column headers in the first row. Use numbers for numeric cells. A cell may be a simple formula such as =SUM(B2:B10).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          sheet_name: { type: "string" },
          rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "boolean"] } } },
        },
        required: ["title", "rows"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_presentation",
      description:
        "Prepare a downloadable PowerPoint presentation. A title slide is added automatically from the title, so do not include one. Each slide has a title and a few short bullet points.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          slides: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                bullets: { type: "array", items: { type: "string" } },
                notes: { type: "string", description: "Optional speaker notes." },
              },
              required: ["title"],
            },
          },
        },
        required: ["title", "slides"],
      },
    },
  },
];

/** Run a "prepare" tool. It only validates; the file is built when the user presses a button. */
export function runFileTool(name, rawArgs) {
  const type = CARD_TYPES[name];
  if (!type) return { content: `Error: unknown tool ${name}`, failed: true };
  try {
    const args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs || {};
    const spec = normalizeSpec({
      type,
      title: args.title,
      markdown: args.content_markdown,
      sheet_name: args.sheet_name,
      rows: args.rows,
      slides: args.slides,
    });
    const formats = FORMATS_BY_TYPE[type];
    const label = { docx: "Word", pdf: "PDF", xlsx: "Excel", pptx: "PowerPoint" };
    return {
      content: JSON.stringify({
        ok: true,
        message: `The ${type} "${spec.title}" is ready. The user can download it as ${formats.map((f) => label[f]).join(" or ")} using the buttons shown in the chat. Reply with one or two sentences about what you made. Do not repeat its contents.`,
      }),
      card: { kind: "file", title: spec.title, spec, formats },
    };
  } catch (err) {
    const message = err instanceof FileSpecError ? err.message : err instanceof SyntaxError ? "The tool arguments were not valid JSON." : "Could not prepare the file.";
    return { content: `Error: ${message}`, failed: true };
  }
}

// ---------------------------------------------------------------------------
// Does this message ask for a file? (Only then are the file tools offered.)
// ---------------------------------------------------------------------------

const VERBS = /\b(draft|write|create|make|prepare|generate|produce|compose|build|put together|turn|convert|export|format|redo|rewrite|give me|send me|need|want)\b/i;
const NOUNS =
  /\b(document|doc|docs|docx|letter|cover letter|report|proposal|resume|r[eé]sum[eé]|cv|memo|contract|agreement|invoice|minutes|policy|brief|essay|plan|business plan|outline|itinerary|agenda|schedule|newsletter|certificate|quotation|brochure|flyer|spreadsheet|excel|xlsx|budget sheet|slides?|slide deck|presentation|powerpoint|pptx|deck)\b/i;
// A file format named on its own is a clear ask ("make a PDF of this", "in Word", "as an Excel file").
const FORMATS_NAMED =
  /\b(pdf|docx|xlsx|pptx|powerpoint|excel|spreadsheet|slide deck|(ms|microsoft) word|word (doc|document|file)|(in|as|to|into) word)\b/i;
const DIRECT = /\b(download(able)?|export|printable|print[- ]ready)\b/i;

export function looksLikeFileRequest(message) {
  const t = String(message || "").slice(0, 2000);
  return DIRECT.test(t) || FORMATS_NAMED.test(t) || (VERBS.test(t) && NOUNS.test(t));
}
