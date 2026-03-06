import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { Root } from "mdast";

import { visit } from "unist-util-visit";

import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { a11yDark } from "react-syntax-highlighter/dist/esm/styles/prism";

/* ─────────────────────────────────────────────────────────────────────────────
   Markdown — renders markdown content respecting design tokens from theme.css
───────────────────────────────────────────────────────────────────────────── */

interface MarkdownProps {
  children: string;
}

export default function Markdown({ children }: MarkdownProps) {
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
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="cursor-pointer text-primary"
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
        },
      ]}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}
