import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ChatBubble } from "./ChatBubble";

describe("ChatBubble", () => {
  test("user role renders the right-aligned .plain bubble", () => {
    const { container } = render(<ChatBubble role="user">Hi</ChatBubble>);
    expect(container.querySelector(".msg.user")).not.toBeNull();
    expect(container.querySelector(".plain")).toHaveTextContent("Hi");
  });

  test("assistant role renders a full-width .msg-body block (no bubble)", () => {
    const { container } = render(<ChatBubble role="assistant">Yo</ChatBubble>);
    const msg = container.querySelector(".msg");
    expect(msg).not.toBeNull();
    expect(msg!.classList.contains("user")).toBe(false);
    expect(container.querySelector(".msg-body")).toHaveTextContent("Yo");
  });
});
