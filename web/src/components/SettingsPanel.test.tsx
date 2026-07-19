import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";

// SettingsPanel picks language + theme. Both setters (setLang/setTheme) fire a fire-and-
// forget saveSettings() network call, so we stub the api module. The i18n + theme runtimes
// are otherwise real (they read/write the localStorage shim).
vi.mock("../lib/api", () => ({
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));

import { applyLang, DEFAULT_LOCALE } from "../lib/i18n";
import { DEFAULT_PREFERENCES, getPreferences, syncPreferences } from "../lib/preferences";
import { SettingsPanel } from "./SettingsPanel";

beforeEach(() => {
  installLocalStorage();
  applyLang(DEFAULT_LOCALE);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("SettingsPanel", () => {
  test("renders the language and theme sections", () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Language")).toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();
    // Both theme groups are labelled.
    expect(screen.getByText("a7t")).toBeInTheDocument();
    expect(screen.getByText("Classic")).toBeInTheDocument();
  });

  test("renders a card for each locale, English active by default", () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Português (Brasil)" })).toHaveAttribute("aria-pressed", "false");
  });

  test("picking a language marks it active and persists + re-translates the UI", async () => {
    const { saveSettings } = await import("../lib/api");
    render(<SettingsPanel onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Português (Brasil)" }));
    expect(screen.getByRole("button", { name: "Português (Brasil)" })).toHaveAttribute("aria-pressed", "true");
    expect(saveSettings).toHaveBeenCalledWith({ lang: "pt-BR" });
    expect(localStorage.getItem("a7t_chat_lang")).toBe("pt-BR");
    // The header now reads the pt-BR string.
    expect(screen.getByText("Configurações")).toBeInTheDocument();
  });

  test("picking a theme marks it active and persists", async () => {
    const { saveSettings } = await import("../lib/api");
    render(<SettingsPanel onClose={() => {}} />);
    // Find any theme card and click it.
    const card = screen.getByRole("button", { name: /Charcoal/ });
    await userEvent.click(card);
    expect(card).toHaveAttribute("aria-pressed", "true");
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: expect.any(String) }));
    expect(localStorage.getItem("a7t_chat_theme")).toBeTruthy();
  });

  test("the close button fires onClose", async () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("backdrop click closes; panel-body click does not", () => {
    const onClose = vi.fn();
    const { container } = render(<SettingsPanel onClose={onClose} />);
    const overlay = container.querySelector(".overlay")!;
    const panel = container.querySelector(".panel")!;
    // Clicking the inner panel is stopped.
    within(panel as HTMLElement).getByText("Settings");
    panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsPanel — customization (#11)", () => {
  beforeEach(() => {
    installLocalStorage();
    applyLang(DEFAULT_LOCALE);
    syncPreferences(DEFAULT_PREFERENCES); // reset the shared store to a known baseline
  });
  afterEach(() => vi.clearAllMocks());

  test("renders every customization section", () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByText("Persona")).toBeInTheDocument();
    expect(screen.getByText("Appearance")).toBeInTheDocument();
    expect(screen.getByText("Accessibility")).toBeInTheDocument();
    expect(screen.getByText("Behavior")).toBeInTheDocument();
    expect(screen.getByLabelText("What should a7t.chat call you?")).toBeInTheDocument();
  });

  test("editing the persona name commits on blur (not per keystroke)", async () => {
    const { saveSettings } = await import("../lib/api");
    render(<SettingsPanel onClose={() => {}} />);
    const input = screen.getByLabelText("What should a7t.chat call you?");
    await userEvent.type(input, "Leo");
    expect(saveSettings).not.toHaveBeenCalled(); // still typing
    await userEvent.tab(); // blur
    expect(saveSettings).toHaveBeenCalledWith({ preferences: expect.objectContaining({ persona: expect.objectContaining({ name: "Leo" }) }) });
    expect(getPreferences().persona.name).toBe("Leo");
  });

  test("toggling a trait chip persists it immediately", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    const chip = screen.getByRole("button", { name: "concise" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(getPreferences().persona.traits).toContain("concise");
    await userEvent.click(chip); // toggle off
    expect(getPreferences().persona.traits).not.toContain("concise");
  });

  test("picking a font updates the visual preference and the DOM", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Serif" }));
    expect(getPreferences().visual.mainFont).toBe("serif");
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toContain("Instrument Serif");
  });

  test("the accessibility switches flip the stored preference", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    const motion = screen.getByRole("switch", { name: "Reduce motion" });
    expect(motion).toHaveAttribute("aria-checked", "false");
    await userEvent.click(motion);
    expect(motion).toHaveAttribute("aria-checked", "true");
    expect(getPreferences().accessibility.reducedMotion).toBe(true);
    expect(document.documentElement.dataset.motion).toBe("reduced");
  });

  test("the font-scale slider clamps into range and applies", () => {
    render(<SettingsPanel onClose={() => {}} />);
    const slider = screen.getByLabelText("Text size") as HTMLInputElement;
    expect(slider.min).toBe("0.8");
    expect(slider.max).toBe("1.4");
  });

  test("the Enter-to-send toggle reflects and updates behavior", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    const toggle = screen.getByRole("switch", { name: "Press Enter to send" });
    expect(toggle).toHaveAttribute("aria-checked", "true"); // default
    await userEvent.click(toggle);
    expect(getPreferences().behavior.enterToSend).toBe(false);
  });

  test("the timer-sound toggle defaults on and mutes the chime when flipped", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    const toggle = screen.getByRole("switch", { name: "Timer sound" });
    expect(toggle).toHaveAttribute("aria-checked", "true"); // default on
    await userEvent.click(toggle);
    expect(getPreferences().behavior.timerSound).toBe(false);
  });
});
