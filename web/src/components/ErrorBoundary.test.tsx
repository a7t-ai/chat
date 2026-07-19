import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

// The boundary catches a throw in its subtree and renders a fallback instead of letting the
// error unmount the whole React tree (the "dark screen" bug). We suppress console.error so
// React's own boundary logging + our componentDidCatch don't spam the test output, and assert
// our log fired.

function Thrower({ boom = true }: { boom?: boolean }) {
  if (boom) throw new Error("kaboom");
  return <div>alive</div>;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  test("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div>ok</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("ok")).toBeInTheDocument();
  });

  test("catches a throw and renders the default fallback, logging the error", () => {
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(console.error).toHaveBeenCalledWith("ErrorBoundary caught an error", expect.any(Error), expect.anything());
  });

  test("a crashing child renders the fallback while siblings OUTSIDE the boundary survive", () => {
    render(
      <div>
        <span>sibling</span>
        <ErrorBoundary fallback={<div>contained</div>}>
          <Thrower />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText("sibling")).toBeInTheDocument();
    expect(screen.getByText("contained")).toBeInTheDocument();
  });

  test("a function fallback receives reset(), which recovers the subtree", async () => {
    const flag = { current: true };
    function Flaky() {
      if (flag.current) throw new Error("boom");
      return <div>recovered</div>;
    }
    render(
      <ErrorBoundary
        fallback={(reset) => (
          <button
            type="button"
            onClick={() => {
              flag.current = false;
              reset();
            }}
          >
            retry
          </button>
        )}
      >
        <Flaky />
      </ErrorBoundary>,
    );
    // Fallback is showing.
    await userEvent.click(screen.getByRole("button", { name: "retry" }));
    // reset() cleared the error; the (now non-throwing) child re-mounts.
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });

  test("the default fallback's 'Try again' resets (app-level backstop shape)", async () => {
    const flag = { current: true };
    function Flaky() {
      if (flag.current) throw new Error("boom");
      return <div>back</div>;
    }
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    flag.current = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("back")).toBeInTheDocument();
  });
});
