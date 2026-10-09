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
  }): Promise<{ items: { str: string; transform: number[] }[] }>;
}

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

  const withText = pages
    .map((p) => ({ page: p.page, text: p.text.trim() }))
    .filter((p) => p.text.length > 0)
    .sort((a, b) => a.page - b.page);

  if (withText.length === 0) {
    throw new Error("PDF has no extractable text (it may be scanned images without OCR)");
  }
  return withText;
}

// Same approach as pdf-parse's default renderer: start a new line whenever the y position changes.
async function renderPage(pageData: PdfJsPage): Promise<string> {
  const content = await pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });

  let text = "";
  let lastY: number | undefined;
  for (const item of content.items) {
    const y = item.transform[5]; // transform is a 2D matrix; index 5 is the y offset
    text += lastY === undefined || lastY === y ? item.str : `\n${item.str}`;
    lastY = y;
  }
  return text;
}
