import pdf from "pdf-parse";

export interface PdfPage {
  page: number;
  text: string;
}

// The subset of pdf.js's page object that pdf-parse hands to `pagerender`.
interface PdfJsPage {
  pageIndex: number;
  getTextContent(options: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }): Promise<{ items: { str: string; transform: number[]; width: number }[] }>;
}

// A horizontal gap wider than this fraction of the font size counts as a word space.
// Kerning inside a word is well under 0.1em; real spaces measured ~0.25em.
const WORD_GAP_EM = 0.15;

export async function parsePdf(buffer: Buffer): Promise<PdfPage[]> {
  if (buffer.length === 0) throw new Error("PDF is empty (0 bytes)");

  const pages: PdfPage[] = [];
  try {
    // pdf-parse only returns the whole document's text, so collect each page as it renders.
    await pdf(buffer, {
      pagerender: async (pageData: PdfJsPage) => {
        const text = await renderPage(pageData);
        pages.push({ page: pageData.pageIndex + 1, text }); // pageIndex is 0-based
        return text;
      },
    });
  } catch (err) {
    throw new Error(`Unreadable PDF: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Raw text: normalizeText() runs later over all pages at once, since headers/footers span pages.
  const withText = pages.filter((p) => p.text.trim().length > 0).sort((a, b) => a.page - b.page);

  if (withText.length === 0) {
    throw new Error("PDF has no extractable text (it may be scanned images without OCR)");
  }
  return withText;
}

// Like pdf-parse's default renderer (new line whenever y changes), but also inserts a space
// when there's a visible gap between items on the same line. The default glues them,
// producing "componentsofqandkare" from separately positioned words.
async function renderPage(pageData: PdfJsPage): Promise<string> {
  const content = await pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });

  let text = "";
  let lastY: number | undefined;
  let lastEndX = 0;
  for (const item of content.items) {
    // transform is a 2D matrix: [scaleX, skewY, skewX, scaleY, x, y]; scaleX ≈ font size
    const [fontSize, , , , x, y] = item.transform;

    if (lastY === undefined) {
      text += item.str;
    } else if (y !== lastY) {
      text += `\n${item.str}`;
    } else {
      const gap = x - lastEndX;
      const hasSpace = /\s$/.test(text) || /^\s/.test(item.str);
      text += !hasSpace && gap > Math.abs(fontSize) * WORD_GAP_EM ? ` ${item.str}` : item.str;
    }

    lastY = y;
    lastEndX = x + item.width;
  }
  return text;
}
