import { useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";

type HastNode = { type: string; value?: string; children?: HastNode[]; properties?: Record<string, unknown> };

function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

function codeLanguage(pre: HastNode | undefined): string {
  const code = pre?.children?.find((c) => c.type === "element");
  const classes = code?.properties?.["className"];
  const list = Array.isArray(classes) ? classes.map(String) : [];
  return list.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
}

function CodeBlock({ node, children }: { node: HastNode | undefined; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const language = codeLanguage(node);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hastText(node).replace(/\n$/, ""));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked; nothing to do.
    }
  };
  return (
    <div className="chat-code">
      <div className="chat-code__bar">
        <span>{language || "code"}</span>
        <button type="button" onClick={() => void copy()} aria-label="Copy code">
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: ({ node, children }) => <CodeBlock node={node as HastNode | undefined}>{children}</CodeBlock>,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: ({ node: _node, ...props }) => (
    <div className="chat-table">
      <table {...props} />
    </div>
  ),
};

/** Chat text with Markdown formatting and colour-highlighted code blocks. */
export function ChatMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[[rehypeHighlight, { detect: true }]]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}
