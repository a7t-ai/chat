import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { InlineMessage } from "./InlineMessage";

describe("InlineMessage", () => {
  test("renders the text with the variant class", () => {
    render(<InlineMessage variant="danger">Nope</InlineMessage>);
    expect(screen.getByText("Nope").closest(".ui-msg")).toHaveClass("ui-msg-danger");
  });

  test("forwards role (e.g. alert) for live validation", () => {
    render(
      <InlineMessage variant="danger" role="alert">
        Boom
      </InlineMessage>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Boom");
  });

  test("shows an icon by default, hides it when icon=false", () => {
    const { container, rerender } = render(<InlineMessage variant="success">ok</InlineMessage>);
    expect(container.querySelector(".ui-msg-icon")).not.toBeNull();
    rerender(
      <InlineMessage variant="success" icon={false}>
        ok
      </InlineMessage>,
    );
    expect(container.querySelector(".ui-msg-icon")).toBeNull();
  });

  test("defaults to the info variant", () => {
    render(<InlineMessage>hi</InlineMessage>);
    expect(screen.getByText("hi").closest(".ui-msg")).toHaveClass("ui-msg-info");
  });
});
