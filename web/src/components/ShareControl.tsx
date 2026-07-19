import { Check, Copy, Link2, Share2 } from "lucide-react";
import { useEffect, useState } from "react";
import { createShare, deleteShare, getShare, type ShareInfo } from "../lib/api";
import { useT } from "../lib/i18n";
import { Button, IconButton, InlineMessage, Input } from "./ui";

// Owner-side control for the shareable-live-collab link. A small Share button that opens a
// popover: when the chat isn't shared it offers "Create link"; once shared it shows the
// `/s/{slug}` link with copy + "Stop sharing". The popover lazy-loads the current status on
// open, so the conversation list isn't taxed with a share lookup per row. The public watch
// page lives in WatchView; this is purely the opt-in toggle.
export function ShareControl({ conversationId }: { conversationId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);

  // Reflect the published state on the button AT REST, not just when the popover opens: the
  // owner should see at a glance (accent-tinted button) that a chat is live-shared. One
  // `getShare` per conversation mount — cheap, and guarded so a resolution after unmount (or a
  // chat switch) never sets state on a stale/gone component. The popover-open path still
  // refreshes on demand below, so an out-of-band change is picked up when they actually open it.
  useEffect(() => {
    let alive = true;
    getShare(conversationId)
      .then((s) => {
        if (alive) setInfo(s);
      })
      .catch(() => {
        /* at-rest status is best-effort; the button just stays un-accented until opened */
      });
    return () => {
      alive = false;
    };
  }, [conversationId]);

  async function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setError(false);
    setCopied(false);
    setInfo(null);
    try {
      setInfo(await getShare(conversationId));
    } catch {
      setError(true);
    }
  }

  async function create() {
    setBusy(true);
    setError(false);
    try {
      setInfo(await createShare(conversationId));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError(false);
    try {
      await deleteShare(conversationId);
      setInfo({ shared: false, slug: null, url: null });
      setCopied(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!info?.url) return;
    try {
      await navigator.clipboard?.writeText(info.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the link stays visible to copy by hand */
    }
  }

  return (
    <div className="share-control menu">
      <IconButton
        size="sm"
        active={!!info?.shared}
        className="share-btn"
        onClick={toggleOpen}
        aria-expanded={open}
        label={t("share.button")}
      >
        <Share2 size={18} strokeWidth={1.75} aria-hidden="true" />
      </IconButton>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu-pop share-pop" role="dialog" aria-label={t("share.title")}>
            <div className="share-head">
              <div className="share-head-row">
                <span className="share-head-ico" aria-hidden="true">
                  <Share2 size={16} strokeWidth={1.75} />
                </span>
                <div className="share-title">{t("share.title")}</div>
              </div>
              <p className="share-intro muted">{t("share.intro")}</p>
            </div>
            {error && (
              <InlineMessage variant="danger" role="alert">
                {t("share.error")}
              </InlineMessage>
            )}
            {info?.shared && info.url ? (
              <>
                <div className="share-link-row">
                  <Input className="share-link" readOnly value={info.url} aria-label={t("share.copyLink")} onFocus={(e) => e.currentTarget.select()} />
                </div>
                <div className="share-actions">
                  <Button variant="primary" size="sm" className="share-copy" onClick={copy} disabled={busy}>
                    {copied ? <Check size={16} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.75} aria-hidden="true" />}
                    {copied ? t("share.copied") : t("share.copyLink")}
                  </Button>
                  <Button variant="ghost" size="sm" className="share-stop" onClick={stop} disabled={busy}>
                    {t("share.unshare")}
                  </Button>
                </div>
              </>
            ) : (
              <Button variant="primary" size="sm" className="full share-create" onClick={create} disabled={busy}>
                <Link2 size={16} strokeWidth={1.75} aria-hidden="true" />
                {busy ? t("share.creating") : t("share.create")}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
