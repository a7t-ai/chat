import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ProfileCard } from "./ProfileCard";

describe("ProfileCard", () => {
  test("renders name, email, avatar initial, and the plan via the DS Badge", () => {
    render(<ProfileCard name="Leo Cardoso" email="leo@a7t.chat" plan="owner" planLabel="Owner" />);
    expect(screen.getByText("Leo Cardoso")).toBeInTheDocument();
    expect(screen.getByText("leo@a7t.chat")).toBeInTheDocument();
    expect(screen.getByText("L")).toBeInTheDocument(); // avatar initial
    // The tier is the shared ui/Badge (accent for a premium tier), not a bespoke .plan-badge pill.
    const badge = screen.getByText("Owner");
    expect(badge).toHaveClass("ui-badge", "ui-badge-accent");
  });

  test("omits the email line when absent; free is a neutral badge", () => {
    render(<ProfileCard name="Sam" plan="free" planLabel="Free" />);
    expect(screen.getByText("Sam")).toBeInTheDocument();
    expect(screen.queryByText(/@/)).toBeNull();
    expect(screen.getByText("Free")).toHaveClass("ui-badge-neutral");
  });
});
