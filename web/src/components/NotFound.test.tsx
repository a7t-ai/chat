import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { NotFound } from "./NotFound";

test("renders the 404 code and heading", () => {
  render(<NotFound />);
  expect(screen.getByText("404")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
});

test("the primary CTA links home and the secondary to help", () => {
  render(<NotFound />);
  expect(screen.getByRole("link", { name: "Back to chat" })).toHaveAttribute("href", "/");
  expect(screen.getByRole("link", { name: "Get help" })).toHaveAttribute("href", "/help");
});
