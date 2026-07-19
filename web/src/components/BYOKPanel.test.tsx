import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ByokKey, ByokListing, ByokProvider, Me } from "../lib/api";

// BYOKPanel is the "Keys" settings surface (#14): list the caller's masked frontier-provider keys,
// add one, remove one, and gracefully degrade when the server has BYOK dark. We mock the api module
// (no network) and cover the dark/empty/list states plus the add + delete + error flows. `me.byok`
// drives the availability gate; GET /api/byok (mocked listByok) supplies the catalog + masked keys.
const listByok = vi.fn();
const setByokKey = vi.fn();
const deleteByokKey = vi.fn();
vi.mock("../lib/api", () => ({
  listByok: (...a: unknown[]) => listByok(...a),
  setByokKey: (...a: unknown[]) => setByokKey(...a),
  deleteByokKey: (...a: unknown[]) => deleteByokKey(...a),
}));

import { BYOKPanel } from "./BYOKPanel";

const CATALOG: ByokProvider[] = [
  { id: "openai", label: "OpenAI", keyHint: "sk-…" },
  { id: "anthropic", label: "Anthropic", keyHint: "sk-ant-…" },
];

function key(over: Partial<ByokKey> = {}): ByokKey {
  return { provider: "openai", last4: "1234", updatedAt: "2026-01-02T00:00:00.000Z", ...over };
}
function listing(over: Partial<ByokListing> = {}): ByokListing {
  return { available: true, providers: CATALOG, keys: [], ...over };
}
function makeMe(available = true): Me {
  return {
    role: "account",
    via: "cookie",
    user: { id: "u1", email: "person@a7t.chat", login: "person" },
    byok: { available, providers: [] },
  } as unknown as Me;
}

beforeEach(() => {
  listByok.mockReset().mockResolvedValue(listing());
  setByokKey.mockReset().mockResolvedValue(key());
  deleteByokKey.mockReset().mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("BYOKPanel — states", () => {
  test("shows the dark empty state and no form when the server has BYOK off", async () => {
    render(<BYOKPanel me={makeMe(false)} onClose={() => {}} embedded />);
    expect(await screen.findByText("Bring-your-own-key isn't configured on this server.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add key" })).not.toBeInTheDocument();
    // A dark server is never queried for the catalog/keys.
    expect(listByok).not.toHaveBeenCalled();
  });

  test("empty state + a provider picker + Add when no keys are configured", async () => {
    render(<BYOKPanel me={makeMe()} onClose={() => {}} embedded />);
    expect(await screen.findByText("You haven't added any keys yet.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Provider" })).toBeInTheDocument();
    // The catalog fills the picker.
    expect(screen.getByRole("option", { name: "OpenAI" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Anthropic" })).toBeInTheDocument();
    // Add is disabled until a key is typed.
    expect(screen.getByRole("button", { name: "Add key" })).toBeDisabled();
  });

  test("lists configured keys masked (provider label + last4) with a Delete each", async () => {
    listByok.mockResolvedValue(listing({ keys: [key({ provider: "openai", last4: "9999" })] }));
    render(<BYOKPanel me={makeMe()} onClose={() => {}} embedded />);
    // Scope to the row cell — "OpenAI" also names an <option> in the provider picker.
    expect(await screen.findByRole("cell", { name: "OpenAI" })).toBeInTheDocument();
    expect(screen.getByText("•••• 9999")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  test("shows a load error when the fetch fails", async () => {
    listByok.mockRejectedValue(new Error("boom"));
    render(<BYOKPanel me={makeMe()} onClose={() => {}} embedded />);
    expect(await screen.findByText("Could not load your keys.")).toBeInTheDocument();
  });
});

describe("BYOKPanel — add", () => {
  test("stores the key for the default provider and refreshes into the list", async () => {
    listByok
      .mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(listing({ keys: [key({ provider: "openai", last4: "4242" })] }));
    render(<BYOKPanel me={makeMe()} onClose={() => {}} embedded />);
    await screen.findByText("You haven't added any keys yet.");
    await userEvent.type(screen.getByLabelText("API key"), "sk-my-secret-4242");
    await userEvent.click(screen.getByRole("button", { name: "Add key" }));
    expect(setByokKey).toHaveBeenCalledWith("openai", "sk-my-secret-4242");
    expect(await screen.findByText("Key saved.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("•••• 4242")).toBeInTheDocument());
    // The secret is cleared from the field once stored.
    expect(screen.getByLabelText("API key")).toHaveValue("");
  });

  test("stores against the chosen provider when the picker is changed", async () => {
    render(<BYOKPanel me={makeMe()} onClose={() => {}} embedded />);
    await screen.findByText("You haven't added any keys yet.");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "anthropic");
    await userEvent.type(screen.getByLabelText("API key"), "sk-ant-key-0001");
    await userEvent.click(screen.getByRole("button", { name: "Add key" }));
    expect(setByokKey).toHaveBeenCalledWith("anthropic", "sk-ant-key-0001");
  });

  test("trims the key before storing it", async () => {
    render(<BYOKPanel me={makeMe()} onClose={() => {}} embedded />);
    await userEvent.type(await screen.findByLabelText("API key"), "  sk-padded-1234  ");
    await userEvent.click(screen.getByRole("button", { name: "Add key" }));
    expect(setByokKey).toHaveBeenCalledWith("openai", "sk-padded-1234");
  });

  test("keeps the typed key and shows an error when storing fails", async () => {
    setByokKey.mockRejectedValue(new Error("bad key"));
    render(<BYOKPanel me={makeMe()} onClose={() => {}} embedded />);
    await userEvent.type(await screen.findByLabelText("API key"), "sk-broken-9999");
    await userEvent.click(screen.getByRole("button", { name: "Add key" }));
    expect(await screen.findByText("Couldn't save that key. Check it and try again.")).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveValue("sk-broken-9999");
  });
});

describe("BYOKPanel — delete", () => {
  test("removes a key after confirm and refreshes", async () => {
    listByok
      .mockResolvedValueOnce(listing({ keys: [key({ provider: "openai", last4: "1234" })] }))
      .mockResolvedValueOnce(listing());
    render(<BYOKPanel me={makeMe()} onClose={() => {}} embedded />);
    await screen.findByText("•••• 1234");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteByokKey).toHaveBeenCalledWith("openai");
    await waitFor(() => expect(screen.getByText("You haven't added any keys yet.")).toBeInTheDocument());
  });

  test("does nothing when the confirm is declined", async () => {
    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    listByok.mockResolvedValue(listing({ keys: [key()] }));
    render(<BYOKPanel me={makeMe()} onClose={() => {}} embedded />);
    await screen.findByText("•••• 1234");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteByokKey).not.toHaveBeenCalled();
  });

  test("shows an error when deletion fails", async () => {
    deleteByokKey.mockRejectedValue(new Error("no"));
    listByok.mockResolvedValue(listing({ keys: [key()] }));
    render(<BYOKPanel me={makeMe()} onClose={() => {}} embedded />);
    await screen.findByText("•••• 1234");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Couldn't remove that key. Please try again.")).toBeInTheDocument();
  });
});

describe("BYOKPanel — close", () => {
  test("the close button dismisses", async () => {
    const onClose = vi.fn();
    // Not embedded: the standalone Modal owns its Close chrome (embedded delegates it to SidebarModal).
    render(<BYOKPanel me={makeMe()} onClose={onClose} />);
    await screen.findByText("You haven't added any keys yet.");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
