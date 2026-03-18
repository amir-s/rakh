import type { MouseEvent as ReactMouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { Content, Link, Parent, Root, Text } from "mdast";

import { visit } from "unist-util-visit";

import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { a11yDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import {
  openFileReference,
  parseFileReferenceHref,
  parsePlainTextFileReference,
} from "@/components/markdownFileReferences";

/* ─────────────────────────────────────────────────────────────────────────────
   Markdown — renders markdown content respecting design tokens from theme.css
───────────────────────────────────────────────────────────────────────────── */

interface MarkdownProps {
  children: string;
  cwd?: string;
  onOpenFileReferenceError?: (details: unknown) => void;
}

const LEADING_PUNCTUATION = new Set(["(", "[", "{", "\"", "'"]);
const TRAILING_PUNCTUATION = new Set([
  ")",
  "]",
  "}",
  "\"",
  "'",
  ".",
  ",",
  "!",
  "?",
  ";",
  ":",
]);

function createTextNode(value: string): Text {
  return { type: "text", value };
}

function createLinkNode(url: string, value: string): Link {
  return {
    type: "link",
    url,
    children: [createTextNode(value)],
  };
}

function splitReferenceToken(token: string): {
  leading: string;
  core: string;
  trailing: string;
} | null {
  let start = 0;
  let end = token.length;

  while (start < end && LEADING_PUNCTUATION.has(token[start] ?? "")) {
    start += 1;
  }
  while (end > start && TRAILING_PUNCTUATION.has(token[end - 1] ?? "")) {
    end -= 1;
  }

  const core = token.slice(start, end);
  if (!core) return null;
  if (!parsePlainTextFileReference(core)) return null;

  return {
    leading: token.slice(0, start),
    core,
    trailing: token.slice(end),
  };
}

function buildLinkedTextNodes(value: string): Content[] | null {
  const nodes: Content[] = [];
  const tokenRegex = /\S+/g;
  let lastIndex = 0;
  let replaced = false;

  for (const match of value.matchAll(tokenRegex)) {
    const token = match[0];
    const index = match.index ?? -1;
    if (index < 0) continue;

    const split = splitReferenceToken(token);
    if (!split) continue;

    if (index > lastIndex) {
      nodes.push(createTextNode(value.slice(lastIndex, index)));
    }
    if (split.leading) {
      nodes.push(createTextNode(split.leading));
    }
    nodes.push(createLinkNode(split.core, split.core));
    if (split.trailing) {
      nodes.push(createTextNode(split.trailing));
    }
    lastIndex = index + token.length;
    replaced = true;
  }

  if (!replaced) return null;
  if (lastIndex < value.length) {
    nodes.push(createTextNode(value.slice(lastIndex)));
  }
  return nodes;
}

export default function Markdown({
  children,
  cwd,
  onOpenFileReferenceError,
}: MarkdownProps) {
  const components: Components = {
    // Inline code
    code: ({ className, children, ref, ...props }) => {
      const isInline = !className?.startsWith("language-");
      if (isInline) {
        return (
          <code className="md-inline-code" {...props}>
            {children}
          </code>
        );
      }
      // Code block
      const match = /language-(\w+)/.exec(className || "");
      return match ? (
        <SyntaxHighlighter
          {...props}
          PreTag="div"
          children={String(children).replace(/\n$/, "")}
          language={match[1]}
          style={a11yDark}
        />
      ) : (
        <code className={`md-code-block ${className ?? ""}`} {...props}>
          {children}
        </code>
      );
    },
    // Pre blocks (wrapping code blocks)
    pre: ({ children }) => {
      return <pre className="md-pre">{children}</pre>;
    },
    // Links
    a: ({ children, href, ...props }) => {
      const localReference =
        typeof href === "string" ? parseFileReferenceHref(href) : null;
      const handleLocalReferenceClick = (
        event: ReactMouseEvent<HTMLAnchorElement>,
      ) => {
        if (!localReference) return;
        event.preventDefault();
        void openFileReference(localReference, {
          cwd,
          onError: onOpenFileReferenceError,
        });
      };

      return (
        <a
          href={href}
          target={localReference ? undefined : "_blank"}
          rel={localReference ? undefined : "noopener noreferrer"}
          className="cursor-pointer text-primary"
          onClick={handleLocalReferenceClick}
          {...props}
        >
          {children}
        </a>
      );
    },
    // Unordered lists
    ul: ({ children, ...props }) => {
      return (
        <ul className="md-ul" {...props}>
          {children}
        </ul>
      );
    },
    // Ordered lists
    ol: ({ children, ...props }) => {
      return (
        <ol className="md-ol" {...props}>
          {children}
        </ol>
      );
    },
    // List items
    li: ({ children, ...props }) => {
      return <li {...props}>{children}</li>;
    },
    // Paragraphs
    p: ({ children, ...props }) => {
      return (
        <p className="md-p" {...props}>
          {children}
        </p>
      );
    },
    // Headings
    h1: ({ children, ...props }) => {
      return (
        <h1 className="md-h1" {...props}>
          {children}
        </h1>
      );
    },
    h2: ({ children, ...props }) => {
      return (
        <h2 className="md-h2" {...props}>
          {children}
        </h2>
      );
    },
    h3: ({ children, ...props }) => {
      return (
        <h3 className="md-h3" {...props}>
          {children}
        </h3>
      );
    },
    // Blockquotes
    blockquote: ({ children, ...props }) => {
      return (
        <blockquote className="md-blockquote" {...props}>
          {children}
        </blockquote>
      );
    },
    // Horizontal rules
    hr: ({ ...props }) => {
      return <hr className="md-hr" {...props} />;
    },
    // Strong/bold
    strong: ({ children, ...props }) => {
      return (
        <strong className="md-strong" {...props}>
          {children}
        </strong>
      );
    },
    // Emphasis/italic
    em: ({ children, ...props }) => {
      return (
        <em className="md-em" {...props}>
          {children}
        </em>
      );
    },
    // Tables
    table: ({ children, ...props }) => (
      <div className="md-table-wrap">
        <table className="md-table" {...props}>
          {children}
        </table>
      </div>
    ),
    thead: ({ children, ...props }) => (
      <thead className="md-thead" {...props}>
        {children}
      </thead>
    ),
    tbody: ({ children, ...props }) => (
      <tbody className="md-tbody" {...props}>
        {children}
      </tbody>
    ),
    tr: ({ children, ...props }) => <tr {...props}>{children}</tr>,
    th: ({ children, ...props }) => (
      <th className="md-th" {...props}>
        {children}
      </th>
    ),
    td: ({ children, ...props }) => (
      <td className="md-td" {...props}>
        {children}
      </td>
    ),
  };

  return (
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        () => (tree: Root) => {
          visit(tree, "code", (node) => {
            node.lang = node.lang ?? "plaintext";
          });
          visit(tree, "text", (node, index, parent) => {
            if (index == null || !parent || parent.type === "link") return;
            const linkedNodes = buildLinkedTextNodes(node.value);
            if (!linkedNodes) return;
            (parent as Parent).children.splice(index, 1, ...linkedNodes);
          });
        },
      ]}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}
