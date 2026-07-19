import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { CapabilityProvider } from "./context";
import { CapabilityMarker } from "./marker";

// CapabilityMarker is what renders in place of a [[id:payload]] marker. It must: render the
// capability's Chip for a known id, raise the payload via the context open() on click, and
// fall back to PLAIN TEXT (never crash) for an unknown id.

describe("CapabilityMarker", () => {
  test("renders the maps Chip for the 'map' id, showing the short place name", () => {
    render(<CapabilityMarker capId="map" payload="Belém Tower, Lisbon, Portugal" />);
    // MapChip shows the first comma-segment.
    expect(screen.getByText("Belém Tower")).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute("title", "Show Belém Tower, Lisbon, Portugal on the map");
  });

  test("clicking the chip raises (id, payload) to the context open()", async () => {
    const open = vi.fn();
    render(
      <CapabilityProvider value={open}>
        <CapabilityMarker capId="map" payload="Berlin, Germany" />
      </CapabilityProvider>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(open).toHaveBeenCalledWith("map", "Berlin, Germany");
  });

  test("falls back to plain text for an unknown capability id", () => {
    const { container } = render(<CapabilityMarker capId="ghost" payload="just some text" />);
    expect(container.textContent).toBe("just some text");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
