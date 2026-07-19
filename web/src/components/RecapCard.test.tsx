import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { Recap } from "../lib/api";
import { RecapCard } from "./RecapCard";

const recap: Recap = {
  topic: "Planning a trip to Lisbon",
  progress: ["Chose dates in May", "Shortlisted three neighborhoods"],
  whereItEnded: "Comparing hotels in Alfama",
  nextStep: "Pick one hotel and check availability",
};

describe("RecapCard", () => {
  test("renders the topic, every progress point, and where it ended", () => {
    render(<RecapCard recap={recap} onDismiss={() => {}} />);
    expect(screen.getByText("Planning a trip to Lisbon")).toBeInTheDocument();
    expect(screen.getByText("Chose dates in May")).toBeInTheDocument();
    expect(screen.getByText("Shortlisted three neighborhoods")).toBeInTheDocument();
    expect(screen.getByText("Comparing hotels in Alfama")).toBeInTheDocument();
    // Labelled as a region so it's a landmark, not an alert.
    expect(screen.getByRole("region", { name: "Where you left off" })).toBeInTheDocument();
  });

  test("shows the next step and a resume button that seeds the composer", async () => {
    const onResume = vi.fn();
    render(<RecapCard recap={recap} onDismiss={() => {}} onResume={onResume} />);
    expect(screen.getByText("Pick one hotel and check availability")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Pick up here" }));
    expect(onResume).toHaveBeenCalledWith("Pick one hotel and check availability");
  });

  test("without onResume the next step is shown as text, with no resume button", () => {
    render(<RecapCard recap={recap} onDismiss={() => {}} />);
    expect(screen.getByText("Pick one hotel and check availability")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pick up here" })).not.toBeInTheDocument();
  });

  test("omits the next-step section entirely when the recap has none", () => {
    const { nextStep, ...noNext } = recap;
    void nextStep;
    render(<RecapCard recap={noNext} onDismiss={() => {}} onResume={() => {}} />);
    expect(screen.queryByText("Suggested next step")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pick up here" })).not.toBeInTheDocument();
  });

  test("the dismiss button fires onDismiss", async () => {
    const onDismiss = vi.fn();
    render(<RecapCard recap={recap} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss recap" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
