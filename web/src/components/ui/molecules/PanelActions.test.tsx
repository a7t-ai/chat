import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Button } from "../atoms/Button";
import { PanelActions } from "./PanelActions";

describe("PanelActions", () => {
  test("right-aligns by default (no between modifier)", () => {
    const { container } = render(
      <PanelActions>
        <Button>Save</Button>
      </PanelActions>,
    );
    const row = container.querySelector(".ui-panel-actions");
    expect(row).not.toBeNull();
    expect(row).not.toHaveClass("ui-panel-actions-between");
  });

  test("align='between' adds the space-between modifier", () => {
    const { container } = render(
      <PanelActions align="between">
        <Button variant="danger">Delete</Button>
        <Button variant="primary">Add</Button>
      </PanelActions>,
    );
    expect(container.querySelector(".ui-panel-actions")).toHaveClass("ui-panel-actions-between");
  });

  test("forwards an extra className", () => {
    const { container } = render(
      <PanelActions className="mt-auto">
        <Button>Go</Button>
      </PanelActions>,
    );
    const row = container.querySelector(".ui-panel-actions");
    expect(row).toHaveClass("mt-auto");
  });

  test("renders its children (the CTAs)", () => {
    render(
      <PanelActions>
        <Button>Cancel</Button>
        <Button variant="primary">Save</Button>
      </PanelActions>,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});
