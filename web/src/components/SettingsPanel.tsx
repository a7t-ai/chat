import { useState } from "react";
import { getLang, LOCALES, type LocaleId, type MessageKey, setLang, useT } from "../lib/i18n";
import {
  CODE_FONTS,
  DENSITIES,
  EXTRA_MAX,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  MAIN_FONTS,
  NAME_MAX,
  ROLE_MAX,
  setPreferences,
  TRAIT_SUGGESTIONS,
  usePreferences,
} from "../lib/preferences";
import { getThemeId, setTheme } from "../lib/theme";
import { THEMES } from "../lib/themes";
import { Field, Input, Modal, SectionHeading, SegmentedControl, TextArea, Toggle } from "./ui";

export function SettingsPanel({ onClose, embedded }: { onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const prefs = usePreferences();
  const [current, setCurrent] = useState(getThemeId());
  const [lang, setCurrentLang] = useState<LocaleId>(getLang());
  // Persona text lives in local state and is committed on blur so we don't fire a save (and a
  // global re-render) on every keystroke. Toggles/chips/sliders are discrete → saved on change.
  const [name, setName] = useState(prefs.persona.name);
  const [role, setRole] = useState(prefs.persona.role);
  const [extra, setExtra] = useState(prefs.persona.extra);

  function pick(id: string) {
    setTheme(id);
    setCurrent(id);
  }
  function pickLang(id: LocaleId) {
    setLang(id);
    setCurrentLang(id);
  }
  function toggleTrait(trait: string) {
    const has = prefs.persona.traits.includes(trait);
    const traits = has ? prefs.persona.traits.filter((x) => x !== trait) : [...prefs.persona.traits, trait];
    setPreferences({ persona: { traits } });
  }

  const groups: Array<"a7t" | "Classic"> = ["a7t", "Classic"];
  const scalePct = Math.round(prefs.accessibility.fontScale * 100);

  return (
    <Modal
      bare={embedded}
      title={t("settings.title")}
      onClose={onClose}
      closeLabel={t("common.close")}
      className="settings-panel"
    >
      {/* A stable wrapper so the section-divider treatment survives `bare` mode (which drops the
          Modal's .settings-panel class) — keeps the spacing scoped to Settings, not every panel. */}
      <div className="settings-body">
        {/* Persona — injected into the system prompt server-side. */}
        <SectionHeading>{t("settings.persona")}</SectionHeading>
        <p className="muted small">{t("settings.personaHint")}</p>
        <Field label={t("settings.personaName")} htmlFor="persona-name">
          <Input
            id="persona-name"
            value={name}
            maxLength={NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setPreferences({ persona: { name } })}
          />
        </Field>
        <Field label={t("settings.personaRole")} htmlFor="persona-role">
          <Input
            id="persona-role"
            value={role}
            maxLength={ROLE_MAX}
            onChange={(e) => setRole(e.target.value)}
            onBlur={() => setPreferences({ persona: { role } })}
          />
        </Field>
        <Field label={t("settings.personaTraits")}>
          <div className="chips" role="group" aria-label={t("settings.personaTraits")}>
            {TRAIT_SUGGESTIONS.map((tr) => {
              const on = prefs.persona.traits.includes(tr);
              return (
                <button key={tr} type="button" className={`chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => toggleTrait(tr)}>
                  {tr}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label={t("settings.personaExtra")} htmlFor="persona-extra">
          <TextArea
            id="persona-extra"
            rows={3}
            value={extra}
            maxLength={EXTRA_MAX}
            onChange={(e) => setExtra(e.target.value)}
            onBlur={() => setPreferences({ persona: { extra } })}
          />
        </Field>

        {/* Appearance — applied client-side. */}
        <SectionHeading>{t("settings.appearance")}</SectionHeading>
        <Field label={t("settings.mainFont")}>
          <SegmentedControl
            value={prefs.visual.mainFont}
            options={MAIN_FONTS.map((o) => ({ value: o, label: t(`font.${o}` as MessageKey) }))}
            onChange={(mainFont) => setPreferences({ visual: { mainFont } })}
            ariaLabel={t("settings.mainFont")}
          />
        </Field>
        <Field label={t("settings.codeFont")}>
          <SegmentedControl
            value={prefs.visual.codeFont}
            options={CODE_FONTS.map((o) => ({ value: o, label: t(`font.${o}` as MessageKey) }))}
            onChange={(codeFont) => setPreferences({ visual: { codeFont } })}
            ariaLabel={t("settings.codeFont")}
          />
        </Field>
        <Field label={t("settings.density")}>
          <SegmentedControl
            value={prefs.visual.density}
            options={DENSITIES.map((o) => ({ value: o, label: t(`density.${o}` as MessageKey) }))}
            onChange={(density) => setPreferences({ visual: { density } })}
            ariaLabel={t("settings.density")}
          />
        </Field>

        {/* Accessibility — first-class. */}
        <SectionHeading>{t("settings.accessibility")}</SectionHeading>
        <label className="slider-field">
          <span className="slider-label">
            {t("settings.fontScale")}
            <span className="slider-val">{scalePct}%</span>
          </span>
          <input
            className="slider"
            type="range"
            min={FONT_SCALE_MIN}
            max={FONT_SCALE_MAX}
            step={0.05}
            value={prefs.accessibility.fontScale}
            onChange={(e) => setPreferences({ accessibility: { fontScale: Number(e.target.value) } })}
            aria-label={t("settings.fontScale")}
          />
        </label>
        <Toggle
          label={t("settings.reducedMotion")}
          checked={prefs.accessibility.reducedMotion}
          onChange={(reducedMotion) => setPreferences({ accessibility: { reducedMotion } })}
        />
        <Toggle
          label={t("settings.highContrast")}
          checked={prefs.accessibility.highContrast}
          onChange={(highContrast) => setPreferences({ accessibility: { highContrast } })}
        />
        <Toggle
          label={t("settings.dyslexiaFont")}
          checked={prefs.accessibility.dyslexiaFont}
          onChange={(dyslexiaFont) => setPreferences({ accessibility: { dyslexiaFont } })}
        />

        {/* Behavior. */}
        <SectionHeading>{t("settings.behavior")}</SectionHeading>
        <Toggle
          label={t("settings.enterToSend")}
          hint={t("settings.enterToSendHint")}
          checked={prefs.behavior.enterToSend}
          onChange={(enterToSend) => setPreferences({ behavior: { enterToSend } })}
        />
        <Toggle
          label={t("settings.timerSound")}
          hint={t("settings.timerSoundHint")}
          checked={prefs.behavior.timerSound}
          onChange={(timerSound) => setPreferences({ behavior: { timerSound } })}
        />

        <SectionHeading>{t("settings.language")}</SectionHeading>
        <div className="lang-grid">
          {LOCALES.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`lang-card ${lang === l.id ? "active" : ""}`}
              onClick={() => pickLang(l.id)}
              aria-pressed={lang === l.id}
            >
              {l.name}
            </button>
          ))}
        </div>

        <SectionHeading>{t("settings.theme")}</SectionHeading>
        {groups.map((g) => (
          <div key={g}>
            <p className="muted small theme-group">{g}</p>
            <div className="theme-grid">
              {THEMES.filter((th) => th.group === g).map((th) => (
                <button
                  key={th.id}
                  type="button"
                  className={`theme-card ${current === th.id ? "active" : ""}`}
                  onClick={() => pick(th.id)}
                  aria-pressed={current === th.id}
                >
                  <span className="theme-prev" style={{ background: th.colors.bg, borderColor: th.colors.border }}>
                    <span className="theme-bar" style={{ background: th.colors.surface2, width: "85%" }} />
                    <span className="theme-bar" style={{ background: th.colors.accent, width: "45%" }} />
                    <span className="theme-bar" style={{ background: th.colors.muted, width: "65%" }} />
                  </span>
                  <span className="theme-name">{th.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
