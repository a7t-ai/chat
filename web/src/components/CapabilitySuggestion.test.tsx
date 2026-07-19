import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { SuggestionHint } from "../lib/api";
import { CapabilitySuggestion } from "./CapabilitySuggestion";

const hint: SuggestionHint = {
  id: "map",
  title: "See it on a map",
  body: "Ask about a place, route, or trip.",
  triggers: ["itinerary"],
};

describe("CapabilitySuggestion", () => {
  test("renders the server-provided title + body", () => {
    render(<CapabilitySuggestion hint={hint} onDismiss={() => {}} />);
    expect(screen.getByText("See it on a map")).toBeInTheDocument();
    expect(screen.getByText("Ask about a place, route, or trip.")).toBeInTheDocument();
    // It's a non-interruptive note, not an alert.
    expect(screen.getByRole("note")).toBeInTheDocument();
  });

  test("the dismiss button fires onDismiss", async () => {
    const onDismiss = vi.fn();
    render(<CapabilitySuggestion hint={hint} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
