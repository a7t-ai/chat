import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { Button, InlineMessage, KeyCaptureField, KeyCombo, Modal, SectionHeading } from "./ui";
import {
  ACTION_LABEL_KEYS,
  beginRecording,
  chordTokens,
  endRecording,
  eventToChord,
  resetBindings,
  setBinding,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
  useBindings,
} from "../lib/keybindings";

// The modifier key differs by platform: Cmd on macOS, Ctrl elsewhere. The global
// shortcuts accept either (see ChatView's keydown handler), but the cheat-sheet shows
// the one that matches the keyboard in front of the user.
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

// Command cheat-sheet + rebinding UI (#16). Opened from the account menu; mirrors the
// overlay/panel pattern of the other dialogs (Settings, Telemetry…). The "General" group is
// user-rebindable (each row records a new chord on click); the composer/palette groups are
// fixed reference rows.
export function KeyboardSheet({ onClose, embedded }: { onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const bindings = useBindings();
  // The action currently capturing a chord, if any.
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  // A rejected rebind: the action we tried to set and the action that already owns the chord.
  const [conflict, setConflict] = useState<{ action: ShortcutAction; owner: ShortcutAction } | null>(null);
  // The last conflict we showed, retained after `conflict` clears so the message keeps its text
  // while it animates OUT (the reveal slot stays mounted and collapses; blanking the text mid-
  // collapse would look abrupt). `displayed` below prefers the live conflict, falling back to this.
  const [shownConflict, setShownConflict] = useState<{ action: ShortcutAction; owner: ShortcutAction } | null>(null);
  useEffect(() => {
    if (conflict) setShownConflict(conflict);
  }, [conflict]);
  const displayed = conflict ?? shownConflict;

  // Esc-to-close is handled by <Modal>. It's a window (bubble-phase) listener, so while recording
  // the capture-phase handler below swallows the Escape (stopPropagation) and it cancels the
  // recording instead of closing the sheet.

  // Capture the next chord for `recording`. Runs in the capture phase so it beats the global
  // shortcut handler AND this sheet's own Esc-to-close, then stops propagation so neither also
  // reacts to the keystroke being bound. `beginRecording()` is a second guard (the global
  // handler bails on `isRecording()`), kept live for the whole session via the cleanup.
  useEffect(() => {
    if (!recording) return;
    const action = recording; // narrow for the closure below
    beginRecording();
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const chord = eventToChord(e);
      if (!chord) return; // still waiting for a mod-anchored combo (a bare/lone-modifier press)
      const res = setBinding(action, chord);
      setConflict(typeof res === "object" ? { action, owner: res.conflict } : null);
      setRecording(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      endRecording();
    };
  }, [recording]);

  function startRecording(action: ShortcutAction) {
    setConflict(null);
    setRecording(action);
  }

  // Fixed reference rows (not rebindable): composer + palette behaviors.
  const staticGroups: { title: string; rows: { label: string; keys: string[] }[] }[] = [
    {
      title: t("keyboard.groupComposer"),
      rows: [
        { label: t("keyboard.send"), keys: ["↵"] },
        { label: t("keyboard.newline"), keys: ["Shift", "↵"] },
        { label: t("keyboard.complete"), keys: ["Tab"] },
      ],
    },
    {
      title: t("keyboard.groupPalette"),
      rows: [
        { label: t("keyboard.navigate"), keys: ["↑", "↓"] },
        { label: t("keyboard.select"), keys: ["↵"] },
        { label: t("keyboard.dismiss"), keys: ["Esc"] },
      ],
    },
  ];

  return (
    <Modal
      bare={embedded}
      title={t("keyboard.title")}
      onClose={onClose}
      closeLabel={t("common.close")}
      className="kbd-panel"
      headerActions={
        <Button variant="ghost" size="sm" onClick={() => resetBindings()}>
          {t("keyboard.reset")}
        </Button>
      }
    >
        {embedded && (
          <div className="embedded-head-actions">
            <Button variant="ghost" size="sm" onClick={() => resetBindings()}>
              {t("keyboard.reset")}
            </Button>
          </div>
        )}
        <section className="kbd-group">
          <SectionHeading>{t("keyboard.groupGeneral")}</SectionHeading>
          <p className="kbd-hint muted small">{t("keyboard.customizeHint")}</p>
          <ul className="kbd-list">
            {SHORTCUT_ACTIONS.map((action) => {
              const label = t(ACTION_LABEL_KEYS[action]);
              const isRec = recording === action;
              return (
                <li key={action} className="kbd-row">
                  <span className="kbd-label">{label}</span>
                  <span className="kbd-keys">
                    <KeyCaptureField
                      keys={chordTokens(bindings[action], IS_MAC)}
                      recording={isRec}
                      placeholder={t("keyboard.recording")}
                      onStart={() => startRecording(action)}
                      ariaLabel={t("keyboard.rebindLabel", { action: label })}
                    />
                  </span>
                  {/* A persistent reveal slot: it collapses/expands (height + fade) whenever this
                      row's conflict toggles, so the message animates in AND out every time and the
                      row's divider glides instead of jumping. Text comes from `displayed` (live
                      conflict, or the retained one during the exit collapse). */}
                  <div className={`kbd-conflict-slot ui-reveal ${conflict?.action === action ? "open" : ""}`}>
                    <div className="kbd-conflict-inner">
                      {displayed?.action === action && (
                        <InlineMessage variant="danger" role="alert" className="kbd-conflict">
                          {t("keyboard.conflict", { action: t(ACTION_LABEL_KEYS[displayed.owner]) })}
                        </InlineMessage>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {staticGroups.map((g) => (
          <section key={g.title} className="kbd-group">
            <SectionHeading>{g.title}</SectionHeading>
            <ul className="kbd-list">
              {g.rows.map((r) => (
                <li key={r.label} className="kbd-row">
                  <span className="kbd-label">{r.label}</span>
                  <span className="kbd-keys">
                    <KeyCombo keys={r.keys} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </Modal>
  );
}
