import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { RecapLoading } from "./RecapLoading";

describe("RecapLoading", () => {
  test("announces the recap is in progress via a polite live region", () => {
    render(<RecapLoading />);
    // role=status so a screen reader hears it; aria-live=polite so it never interrupts.
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Recapping this conversation...");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  test("reuses the RecapCard frame so it reads as the recap arriving", () => {
    const { container } = render(<RecapLoading />);
    // Same card chrome as RecapCard (.recap-card) plus the loading modifier.
    const card = container.querySelector(".recap-card.recap-loading");
    expect(card).not.toBeNull();
    // The pulsing icon carries a stable class the CSS motion-gates; it's decorative to a11y.
    const ico = container.querySelector(".recap-loading-ico");
    expect(ico).not.toBeNull();
    expect(ico).toHaveAttribute("aria-hidden", "true");
  });
});
