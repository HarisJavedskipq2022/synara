// FILE: jiraText.ts
// Purpose: Turn Jira's Atlassian Document Format into bounded plain text for an agent to read.
// Layer: Server domain helpers (pure)
// Exports: cleanJiraText, jiraDocumentToText
//
// Converter adapted from Arbor's apps/daemon/src/jiraText.ts (Apache-2.0).

const MAX_NODES = 4_000;
const MAX_DEPTH = 24;

/** Drops terminal controls and invisible direction overrides from untrusted Jira text. */
export function cleanJiraText(value: string, max: number): string {
  return (
    value
      // oxlint-disable-next-line no-control-regex -- control characters are what is being removed
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩]/g, "")
      .slice(0, max)
  );
}

interface DocumentNode {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly attrs?: unknown;
  readonly content?: unknown;
}

function asNode(value: unknown): DocumentNode | null {
  return value !== null && typeof value === "object" ? (value as DocumentNode) : null;
}

/**
 * Plain text for one Jira document. Paragraphs are separated by a blank line, list items start
 * with `- ` or their number, and code blocks are fenced. Unknown nodes keep their text children.
 */
export function jiraDocumentToText(document: unknown, max: number): string {
  if (typeof document === "string") return cleanJiraText(document, max).trim();
  let visited = 0;

  const render = (value: unknown, depth: number): string => {
    if (++visited > MAX_NODES || depth > MAX_DEPTH) return "";
    const node = asNode(value);
    if (!node) return "";
    if (node.type === "text") return typeof node.text === "string" ? node.text : "";
    if (node.type === "hardBreak") return "\n";
    if (node.type === "mention" || node.type === "emoji" || node.type === "inlineCard") {
      const attrs = asNode(node.attrs) as Record<string, unknown> | null;
      const label = attrs?.text ?? attrs?.shortName ?? attrs?.url;
      return typeof label === "string" ? label : "";
    }
    const children = Array.isArray(node.content) ? node.content.slice(0, MAX_NODES) : [];
    if (node.type === "bulletList" || node.type === "orderedList") {
      const items = children.map((child, index) => {
        const prefix = node.type === "bulletList" ? "- " : `${index + 1}. `;
        const body = render(child, depth + 1).trim();
        return prefix + body.replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
      });
      return `${items.join("\n")}\n\n`;
    }
    const body = children.map((child) => render(child, depth + 1)).join("");
    if (node.type === "codeBlock") return `\`\`\`\n${body}\n\`\`\`\n\n`;
    if (node.type === "listItem") return body.trim();
    if (
      node.type === "paragraph" ||
      node.type === "heading" ||
      node.type === "blockquote" ||
      node.type === "panel" ||
      node.type === "rule" ||
      node.type === "tableRow"
    )
      return `${body}\n\n`;
    if (node.type === "tableCell" || node.type === "tableHeader") return `${body.trim()} | `;
    return body;
  };

  return cleanJiraText(render(document, 0), max * 2)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}
