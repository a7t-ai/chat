import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { Modal } from "./Modal";

describe("Modal", () => {
  test("renders a labelled dialog with its content", () => {
    render(
      <Modal title="Settings" onClose={() => {}}>
        body
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  test("Close button + backdrop click fire onClose; a click inside the panel does not", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal title="X" onClose={onClose}>
        b
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("dialog")); // stopPropagation — no close
    fireEvent.click(container.querySelector(".overlay")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("Escape closes it", () => {
    const onClose = vi.fn();
    render(
      <Modal title="X" onClose={onClose}>
        b
      </Modal>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("renders headerActions alongside Close", () => {
    render(
      <Modal title="X" onClose={() => {}} headerActions={<button>Reset</button>}>
        b
      </Modal>,
    );
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
