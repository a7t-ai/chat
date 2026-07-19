import { useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import { useT } from "../lib/i18n";
import { BLOCK_ICONS, BlockAct, BlockBar, BlockFrame } from "./blocks";

// Map a fenced-code language to a sensible download extension.
const EXT: Record<string, string> = {
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  jsx: "jsx",
  tsx: "tsx",
  python: "py",
  py: "py",
  ruby: "rb",
  rust: "rs",
  golang: "go",
  go: "go",
  java: "java",
  kotlin: "kt",
  swift: "swift",
  csharp: "cs",
  cpp: "cpp",
  c: "c",
  shell: "sh",
  bash: "sh",
  sh: "sh",
  zsh: "sh",
  json: "json",
  yaml: "yml",
  yml: "yml",
  toml: "toml",
  markdown: "md",
  md: "md",
  html: "html",
  css: "css",
  sql: "sql",
};

export function CodeBlock({ code, language }: { code: string; language: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);

  const lang = language.toLowerCase();

  // Highlight once per (code, language) change. Falls back to plain text for
  // unknown languages so the block still renders during streaming.
  const html = useMemo(() => {
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      }
    } catch {
      /* fall through to escaped plain text */
    }
    return escapeHtml(code);
  }, [code, lang]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }

  function download() {
    const ext = EXT[lang] ?? "txt";
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `snippet.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <BlockFrame className="code-block">
      <BlockBar label={<span className="code-lang">{language || t("block.text")}</span>}>
        <BlockAct
          icon={BLOCK_ICONS.wrap}
          on={wrap}
          pressed={wrap}
          onClick={() => setWrap((w) => !w)}
          title={wrap ? t("block.noWrap") : t("block.wrapLines")}
          label={wrap ? t("block.noWrap") : t("block.wrapLines")}
        />
        <BlockAct icon={copied ? BLOCK_ICONS.check : BLOCK_ICONS.copy} onClick={copy} title={t("common.copy")} label={t("block.copyCode")} />
        <BlockAct icon={BLOCK_ICONS.download} onClick={download} title={t("block.download")} label={t("block.downloadCode")} />
      </BlockBar>
      <pre className={wrap ? "wrap" : ""}>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </BlockFrame>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
