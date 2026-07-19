import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TableBlock } from "./TableBlock";

// TableBlock wraps a markdown <table> in our shared block frame with copy (markdown),
// download (CSV), and a native-fullscreen toggle. We mock streamdown's table-extraction
// helpers (so we don't depend on its DOM walk) and stub clipboard + the Fullscreen API,
// which jsdom doesn't implement.

vi.mock("streamdown", () => ({
  extractTableDataFromElement: vi.fn(() => ({ headers: ["a"], rows: [["1"]] })),
  tableDataToMarkdown: vi.fn(() => "| a |\n| 1 |"),
  tableDataToCSV: vi.fn(() => "a\n1"),
}));

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:csv"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderTable() {
  return render(
    <TableBlock>
      <tbody>
        <tr>
          <td>cell</td>
        </tr>
      </tbody>
    </TableBlock>,
  );
}

describe("TableBlock", () => {
  test("renders the wrapped table with its children", () => {
    const { container } = renderTable();
    expect(container.querySelector("table.md-table")).not.toBeNull();
    expect(screen.getByText("cell")).toBeInTheDocument();
  });

  test("copy converts the table to markdown and writes it", async () => {
    const sd = await import("streamdown");
    renderTable();
    await userEvent.click(screen.getByRole("button", { name: "Copy table" }));
    expect(sd.extractTableDataFromElement).toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("| a |\n| 1 |");
  });

  test("download converts to CSV and builds a blob URL", async () => {
    const sd = await import("streamdown");
    renderTable();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "Download table as CSV" }));
    expect(sd.tableDataToCSV).toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:csv");
    clickSpy.mockRestore();
  });

  test("the fullscreen button requests fullscreen on the frame", async () => {
    const req = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: req,
    });
    renderTable();
    await userEvent.click(screen.getByRole("button", { name: "View table fullscreen" }));
    expect(req).toHaveBeenCalledTimes(1);
  });

  test("the fullscreenchange handler flips the toggle label when the frame is fullscreen", () => {
    const { container } = renderTable();
    const frame = container.querySelector(".table-block") as HTMLElement;
    // Pretend the browser entered fullscreen on our frame.
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: frame });
    fireEvent(document, new Event("fullscreenchange"));
    expect(screen.getByRole("button", { name: "Exit fullscreen" })).toBeInTheDocument();
    // Clicking it now exits.
    const exit = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    expect(exit).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
  });
});
