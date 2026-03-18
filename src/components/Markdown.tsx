import { useEffect, useId, useState } from "react";
import type {
  ComponentPropsWithoutRef,
  MouseEvent as ReactMouseEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components, ExtraProps } from "react-markdown";
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

type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & ExtraProps;

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (
    id: string,
    text: string,
  ) => Promise<{
    svg: string;
    bindFunctions?: (element: Element) => void;
  }>;
};

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

let mermaidApiPromise: Promise<MermaidApi> | null = null;

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

function renderCodeBlock(content: string, language: string) {
  return (
    <SyntaxHighlighter PreTag="div" language={language} style={a11yDark}>
      {content}
    </SyntaxHighlighter>
  );
}

async function loadMermaidApi(): Promise<MermaidApi> {
  if (!mermaidApiPromise) {
    mermaidApiPromise = import("mermaid")
      .then((module) => module.default as MermaidApi)
      .catch((error) => {
        mermaidApiPromise = null;
        throw error;
      });
  }
  return mermaidApiPromise;
}

function readTokenValue(styles: CSSStyleDeclaration, name: string) {
  return styles.getPropertyValue(name).trim();
}

function getMermaidConfig() {
  const styles = getComputedStyle(document.documentElement);
  const themeMode = document.documentElement.dataset.theme;
  const background = readTokenValue(styles, "--color-surface") || "#232326";
  const elevated = readTokenValue(styles, "--color-elevated") || "#121214";
  const subtle = readTokenValue(styles, "--color-subtle") || "#2e2e32";
  const text = readTokenValue(styles, "--color-text") || "#e6e6e6";
  const muted = readTokenValue(styles, "--color-muted") || "#8f8f94";
  const primary = readTokenValue(styles, "--color-primary") || "#ec9513";
  const error = readTokenValue(styles, "--color-error") || "#cf6b6b";
  const success = readTokenValue(styles, "--color-success") || "#6ca87c";
  const info = readTokenValue(styles, "--color-info") || "#74aee6";

  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      darkMode: themeMode !== "light",
      background,
      primaryColor: background,
      primaryBorderColor: primary,
      primaryTextColor: text,
      secondaryColor: subtle,
      secondaryBorderColor: subtle,
      secondaryTextColor: text,
      tertiaryColor: elevated,
      tertiaryBorderColor: subtle,
      tertiaryTextColor: text,
      mainBkg: background,
      nodeBorder: primary,
      clusterBkg: elevated,
      clusterBorder: subtle,
      defaultLinkColor: muted,
      lineColor: muted,
      textColor: text,
      edgeLabelBackground: background,
      labelBackground: background,
      labelTextColor: text,
      actorBkg: background,
      actorBorder: primary,
      actorTextColor: text,
      actorLineColor: muted,
      signalColor: muted,
      signalTextColor: text,
      noteBkgColor: elevated,
      noteBorderColor: subtle,
      noteTextColor: text,
      sectionBkgColor: elevated,
      altSectionBkgColor: subtle,
      gridColor: subtle,
      cScale0: background,
      cScale1: subtle,
      cScale2: elevated,
      cScale3: primary,
      cScale4: success,
      cScale5: info,
      cScale6: error,
      cScale7: primary,
      git0: primary,
      git1: success,
      git2: info,
      git3: error,
      tagLabelColor: background,
    },
  };
}

function MermaidDiagram({ source }: { source: string }) {
  const instanceId = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [themeVersion, setThemeVersion] = useState(0);

  useEffect(() => {
    if (typeof MutationObserver === "undefined") {
      return undefined;
    }

    const root = document.documentElement;
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.type === "attributes" &&
            (record.attributeName === "data-theme" ||
              record.attributeName === "data-theme-name"),
        )
      ) {
        setThemeVersion((value) => value + 1);
      }
    });

    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-name"],
    });

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      setSvg(null);
      setError(null);

      try {
        const mermaid = await loadMermaidApi();
        mermaid.initialize(getMermaidConfig());
        const renderId = `md-mermaid-${instanceId}-${themeVersion}`;
        const result = await mermaid.render(renderId, source);
        if (cancelled) return;
        setSvg(result.svg);
      } catch (renderError) {
        if (cancelled) return;
        const message =
          renderError instanceof Error
            ? renderError.message
            : "Unable to render Mermaid diagram.";
        setError(message);
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [instanceId, source, themeVersion]);

  if (error) {
    return (
      <div className="md-mermaid md-mermaid--error" data-mermaid-state="error">
        <div className="md-mermaid__error">
          Mermaid render failed. Showing source instead.
        </div>
        {renderCodeBlock(source, "plaintext")}
      </div>
    );
  }

  return (
    <div className="md-mermaid" data-mermaid-state={svg ? "ready" : "loading"}>
      {!svg ? <div className="md-mermaid__status">Rendering Mermaid diagram…</div> : null}
      <div
        className="md-mermaid__canvas"
        aria-label="Mermaid diagram"
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
    </div>
  );
}

function MarkdownCode({ className, children, node: _node, ...props }: MarkdownCodeProps) {
  const isInline = !className?.startsWith("language-");
  if (isInline) {
    return (
      <code className="md-inline-code" {...props}>
        {children}
      </code>
    );
  }

  const content = String(children).replace(/\n$/, "");
  const match = /language-([\w-]+)/.exec(className || "");
  const language = match?.[1]?.toLowerCase() ?? "plaintext";

  if (language === "mermaid") {
    return <MermaidDiagram source={content} />;
  }

  return renderCodeBlock(content, language);
}

export default function Markdown({
  children,
  cwd,
  onOpenFileReferenceError,
}: MarkdownProps) {
  const components: Components = {
    code: MarkdownCode,
    pre: ({ children }) => {
      return <div className="md-pre">{children}</div>;
    },
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
    ul: ({ children, ...props }) => {
      return (
        <ul className="md-ul" {...props}>
          {children}
        </ul>
      );
    },
    ol: ({ children, ...props }) => {
      return (
        <ol className="md-ol" {...props}>
          {children}
        </ol>
      );
    },
    li: ({ children, ...props }) => {
      return <li {...props}>{children}</li>;
    },
    p: ({ children, ...props }) => {
      return (
        <p className="md-p" {...props}>
          {children}
        </p>
      );
    },
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
    blockquote: ({ children, ...props }) => {
      return (
        <blockquote className="md-blockquote" {...props}>
          {children}
        </blockquote>
      );
    },
    hr: ({ ...props }) => {
      return <hr className="md-hr" {...props} />;
    },
    strong: ({ children, ...props }) => {
      return (
        <strong className="md-strong" {...props}>
          {children}
        </strong>
      );
    },
    em: ({ children, ...props }) => {
      return (
        <em className="md-em" {...props}>
          {children}
        </em>
      );
    },
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
