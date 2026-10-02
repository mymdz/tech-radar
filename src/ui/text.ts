export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export function safeUrl(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
      const url = safeUrl(href.replace(/&amp;/g, '&'));
      return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${label}</a>` : label;
    });
}

/**
 * Just enough Markdown for descriptions written in YAML: paragraphs,
 * "- " bullet lists, **bold**, `code` and [links](https://…).
 */
export function miniMarkdown(source: string): string {
  const blocks = source.trim().split(/\n\s*\n/);
  return blocks
    .map((block) => {
      const lines = block.split('\n').map((line) => line.trim());
      if (lines.every((line) => /^[-*]\s+/.test(line))) {
        return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    })
    .join('');
}
