import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { StatCard } from "./StatCard";

test("renders the value and label", () => {
  render(<StatCard label="Users" value={128} />);
  expect(screen.getByText("128")).toBeInTheDocument();
  expect(screen.getByText("Users")).toBeInTheDocument();
});

test("accepts a string value (e.g. tokens in / out)", () => {
  render(<StatCard label="Tokens" value="7 / 80" />);
  expect(screen.getByText("7 / 80")).toBeInTheDocument();
});
