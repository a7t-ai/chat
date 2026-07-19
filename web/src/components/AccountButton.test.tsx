import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { AccountButton } from "./AccountButton";

test("shows name + role + avatar initial, uses label as accessible name, and fires onClick", async () => {
  const onClick = vi.fn();
  render(<AccountButton name="Leo Cardoso" role="Admin" label="Account menu" onClick={onClick} />);
  const btn = screen.getByRole("button", { name: "Account menu" });
  expect(btn).toHaveTextContent("Leo Cardoso");
  expect(btn).toHaveTextContent("Admin");
  expect(screen.getByText("L")).toBeInTheDocument(); // avatar initial
  await userEvent.click(btn);
  expect(onClick).toHaveBeenCalledOnce();
});
