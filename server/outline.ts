/** How to reach one Outline document: a private one by id (needs a token) or a public share. */
export interface OutlineDocument {
  baseUrl: string;
  token?: string;
  documentId?: string;
  shareId?: string;
}

export interface FetchedDocument {
  /** The document's Markdown as stored by Outline. */
  text: string;
  /**
   * When the document was last edited. Outline leaves it out of public shares
   * unless the share has "Show last modified" turned on.
   */
  updatedAt?: string;
}

const MAX_ERROR_BODY = 512;

export async function fetchDocument(doc: OutlineDocument, timeoutMs = 10_000): Promise<FetchedDocument> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (doc.token) headers.Authorization = `Bearer ${doc.token}`;

  const response = await fetch(`${doc.baseUrl.replace(/\/+$/, '')}/api/documents.info`, {
    method: 'POST',
    headers,
    body: JSON.stringify(doc.documentId ? { id: doc.documentId } : { shareId: doc.shareId }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    // Outline error payloads never echo the Authorization header, so the excerpt is safe to log.
    const excerpt = (await response.text()).slice(0, MAX_ERROR_BODY).trim();
    throw new Error(`Outline documents.info returned ${response.status}: ${excerpt}`);
  }

  const payload = (await response.json()) as { data?: { text?: string; updatedAt?: string } };
  const updatedAt = payload.data?.updatedAt;
  return { text: payload.data?.text ?? '', updatedAt: updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : undefined };
}

const FENCE_OPEN = /^[ \t]*(```|~~~)[ \t]*ya?ml[ \t]*\r?\n/m;

/**
 * The radar lives in the first fenced block tagged yaml/yml; everything around it
 * is free-form notes. The block ends at the first line that is exactly its fence,
 * so backticks inside values don't close it.
 */
export function extractYaml(markdown: string): string {
  const open = FENCE_OPEN.exec(markdown);
  if (!open) throw new Error('the document has no ```yaml block');

  const rest = markdown.slice(open.index + open[0].length);
  const fence = open[1].replace(/[`~]/g, '\\$&');
  const close = new RegExp(`^[ \\t]*${fence}[ \\t]*\\r?$`, 'm').exec(rest);
  if (!close) throw new Error('the ```yaml block in the document is never closed');

  return `${rest.slice(0, close.index).replace(/[\r\n]+$/, '')}\n`;
}
