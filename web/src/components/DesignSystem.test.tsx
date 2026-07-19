import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { DesignSystem } from "./DesignSystem";

describe("DesignSystem gallery", () => {
  test("renders the layer sections and live primitive specimens", () => {
    render(<DesignSystem />);
    expect(screen.getByRole("heading", { name: "Design System" })).toBeInTheDocument();
    expect(screen.getByText("Tokens")).toBeInTheDocument();
    expect(screen.getByText("Atoms")).toBeInTheDocument();
    expect(screen.getByText("Molecules")).toBeInTheDocument();
    // Real components render on the page.
    expect(screen.getByRole("button", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByText("Already used by “New chat”")).toBeInTheDocument();
    // The PanelActions specimen renders both variants (default right-aligned + space-between).
    const between = document.querySelector(".ui-panel-actions-between");
    expect(between).not.toBeNull();
    expect(within(between as HTMLElement).getByRole("button", { name: "Add passkey" })).toBeInTheDocument();
  });

  test("the KeyCaptureField specimen toggles recording on click", () => {
    render(<DesignSystem />);
    const capture = screen.getByRole("button", { name: "Demo shortcut capture" });
    expect(capture).not.toHaveAttribute("data-recording");
    fireEvent.click(capture);
    expect(capture).toHaveAttribute("data-recording", "true");
  });

  test("the Modal specimen opens and closes", () => {
    render(<DesignSystem />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const dialog = screen.getByRole("dialog", { name: "Dialog title" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("Organisms + Chat sections render", () => {
    render(<DesignSystem />);
    expect(screen.getByText("Organisms")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    // A chat bubble and the message actions render.
    expect(screen.getByText(/weather in Lisbon/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument();
  });

  // The extracted ModelPicker (#142) is showcased open + inline: the search box, tier filters,
  // favorite stars, and $-tier / BYOK badges must all be visible on the page.
  describe("ModelPicker specimen (#142)", () => {
    test("renders the picker open with search, filters, favorites, and badges", () => {
      render(<DesignSystem />);
      // Search box + the four tier filters render open (no click needed).
      expect(screen.getByRole("textbox", { name: "Search models" })).toBeInTheDocument();
      const filters = screen.getByRole("group", { name: "Filter models" });
      for (const name of ["All", "Favorites", "Free", "Premium"]) {
        expect(within(filters).getByRole("button", { name })).toBeInTheDocument();
      }
      // Badges: the pro model shows $$, the ultra model $$$, and both frontier models are BYOK.
      const list = screen.getByRole("listbox", { name: "Select model" });
      expect(within(list).getByText("$$")).toBeInTheDocument();
      expect(within(list).getByText("$$$")).toBeInTheDocument();
      expect(within(list).getAllByText("BYOK").length).toBeGreaterThanOrEqual(2);
      // The seeded favorite (GPT-5) floats to the top and shows the "Unfavorite" star.
      const names = Array.from(list.querySelectorAll(".model-option-name")).map((n) => n.textContent);
      expect(names[0]).toBe("GPT-5");
      expect(within(list).getByRole("button", { name: "Unfavorite GPT-5" })).toBeInTheDocument();
    });

    test("search narrows the list; picking a model updates the trigger", async () => {
      render(<DesignSystem />);
      const list = screen.getByRole("listbox", { name: "Select model" });
      const search = screen.getByRole("textbox", { name: "Search models" });
      await userEvent.type(search, "opus");
      expect(within(list).getByText("Claude Opus 4")).toBeInTheDocument();
      expect(within(list).queryByText("GPT-5")).toBeNull();
      await userEvent.clear(search);
      // Selecting a model updates the picker trigger button (the specimen's live selection).
      await userEvent.click(within(list).getByText("Llama 3 (local)"));
      const trigger = screen.getByRole("button", { name: "Select model" });
      expect(trigger).toHaveTextContent("Llama 3 (local)");
    });

    test("favoriting in the gallery is ephemeral (never writes the shared favorites key)", async () => {
      localStorage.removeItem("a7t_chat_model_favorites");
      render(<DesignSystem />);
      await userEvent.click(screen.getByRole("button", { name: "Favorite Qwen3 Omni" }));
      expect(screen.getByRole("button", { name: "Unfavorite Qwen3 Omni" })).toBeInTheDocument();
      // The showcase must not pollute the real per-device favorites store.
      expect(localStorage.getItem("a7t_chat_model_favorites")).toBeNull();
    });
  });
});
