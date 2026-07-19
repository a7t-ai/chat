import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FC } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";
import type { ClientCapability } from "./types";

// CapabilitySurface IS the stable drawer shell: one persistent, animated <aside.cap-drawer>
// that owns the width + resizer, with the capability's own content rendered INSIDE via
// Suspense. We mock the registry so we DON'T pull the real maps Surface (heavy MapLibre chunk)
// into the test. We assert: nothing renders for unknown/Surface-less capabilities; a present
// Surface renders inside a SINGLE animated aside (so the slide-in plays once); the shell
// threads its width down; and the resizer drag persists a new width.

const eager: FC<{ requests: string[]; onClose: () => void; width?: number }> = ({ requests, width }) => (
  <div data-testid="surface">
    surface:{requests.join(",")} w:{width}
  </div>
);

const caps: Record<string, ClientCapability> = {
  map: { id: "map", surfaceLabel: "Map", Chip: () => null, Surface: eager },
  other: { id: "other", Chip: () => null, Surface: eager }, // a non-map Surface (else fallback)
  chiponly: { id: "chiponly", Chip: () => null }, // no Surface
};

vi.mock("./registry", () => ({
  capabilityById: (id: string) => caps[id],
}));

let CapabilitySurface: typeof import("./surface").CapabilitySurface;

beforeEach(async () => {
  installLocalStorage();
  ({ CapabilitySurface } = await import("./surface"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CapabilitySurface", () => {
  test("renders nothing for an unknown capability id", async () => {
    const { container } = render(<CapabilitySurface capId="ghost" requests={[]} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing for a capability without a Surface", async () => {
    const { container } = render(<CapabilitySurface capId="chiponly" requests={["x"]} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders the Surface fed its requests inside a single animated shell aside", async () => {
    const { container } = render(<CapabilitySurface capId="map" requests={["Berlin", "Lisbon"]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("surface")).toHaveTextContent("surface:Berlin,Lisbon"));
    // Exactly ONE .cap-drawer (the stable shell) so cap-slide-in plays exactly once.
    expect(container.querySelectorAll(".cap-drawer")).toHaveLength(1);
    // The shell carries the capability's accessible name + the resizer handle.
    expect(screen.getByRole("complementary", { name: "Map" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize panel" })).toBeInTheDocument();
  });

  test("threads the shell width down to the Surface", async () => {
    render(<CapabilitySurface capId="map" requests={[]} onClose={() => {}} />);
    // Default width when nothing persisted is 440.
    await waitFor(() => expect(screen.getByTestId("surface")).toHaveTextContent("w:440"));
  });

  test("renders a non-map Surface too (generic loading branch)", async () => {
    const { container } = render(<CapabilitySurface capId="other" requests={["z"]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("surface")).toHaveTextContent("surface:z"));
    // No surfaceLabel -> the aside is an unnamed complementary landmark.
    expect(container.querySelector("aside.cap-drawer")).not.toBeNull();
  });

  test("dragging the resizer persists a new width and threads it down", async () => {
    render(<CapabilitySurface capId="map" requests={[]} onClose={() => {}} />);
    const resizer = await screen.findByRole("separator", { name: "Resize panel" });
    fireEvent.pointerDown(resizer, { clientX: 800 });
    fireEvent.pointerMove(document, { clientX: 600 }); // dragging left widens the drawer
    fireEvent.pointerUp(document);
    // startW 440 + (800-600) = 640, within [320, 0.95*innerWidth].
    await waitFor(() => expect(screen.getByTestId("surface")).toHaveTextContent("w:640"));
    expect(Number(localStorage.getItem("a7t_chat_cap_width"))).toBe(640);
  });

  test("restores a persisted width on mount", async () => {
    localStorage.setItem("a7t_chat_cap_width", "512");
    render(<CapabilitySurface capId="map" requests={[]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("surface")).toHaveTextContent("w:512"));
  });
});
