import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { extractTableDataFromElement, tableDataToCSV, tableDataToMarkdown } from "streamdown";
import { useT } from "../lib/i18n";
import { BLOCK_ICONS, BlockAct, BlockBar, BlockFrame } from "./blocks";

// Custom renderer for markdown tables. Streamdown's default table wrapper ships
// its own copy/download/fullscreen controls, but they don't match our visual
// language (see the stacked pills in the original design report) — so we disable
// them (controls={{ table: false }} on <Streamdown>) and render the table inside
// our shared block frame with the same toolbar code blocks use.

export function TableBlock({ children }: { children?: ReactNode }) {
  const t = useT();
  const frameRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Track native fullscreen so the toggle icon reflects reality even when the
  // user exits with Escape rather than the button.
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const copy = useCallback(async () => {
    if (!tableRef.current) return;
    try {
      const data = extractTableDataFromElement(tableRef.current);
      await navigator.clipboard.writeText(tableDataToMarkdown(data));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }, []);

  const download = useCallback(() => {
    if (!tableRef.current) return;
    const data = extractTableDataFromElement(tableRef.current);
    const blob = new Blob([tableDataToCSV(data)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "table.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === frameRef.current) {
        await document.exitFullscreen();
      } else {
        await frameRef.current?.requestFullscreen();
      }
    } catch {
      /* fullscreen unsupported or denied */
    }
  }, []);

  return (
    <BlockFrame className="table-block" ref={frameRef}>
      <BlockBar>
        <BlockAct icon={copied ? BLOCK_ICONS.check : BLOCK_ICONS.copy} onClick={copy} title={t("common.copy")} label={t("block.copyTable")} />
        <BlockAct icon={BLOCK_ICONS.download} onClick={download} title={t("block.downloadCsv")} label={t("block.downloadTableCsv")} />
        <BlockAct
          icon={fullscreen ? BLOCK_ICONS.collapse : BLOCK_ICONS.expand}
          on={fullscreen}
          pressed={fullscreen}
          onClick={toggleFullscreen}
          title={fullscreen ? t("block.exitFullscreen") : t("block.fullscreen")}
          label={fullscreen ? t("block.exitFullscreen") : t("block.viewFullscreen")}
        />
      </BlockBar>
      <div className="block-scroll">
        <table ref={tableRef} className="md-table">
          {children}
        </table>
      </div>
    </BlockFrame>
  );
}
