import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FileMeta, FilesListing } from "../lib/api";

// FilesPanel is the per-account "your files" manager (#15): LIST + download + multi-select delete
// (uploading happens in the prompt field, not here). We mock the api module (no network) and cover
// the listing + empty state, the byte formatter, select + Delete selected, Delete all, and errors.
const listFiles = vi.fn();
const deleteFile = vi.fn();
vi.mock("../lib/api", () => ({
  listFiles: (...a: unknown[]) => listFiles(...a),
  deleteFile: (...a: unknown[]) => deleteFile(...a),
  fileDownloadUrl: (id: string) => `/api/files/${id}`,
}));

import { FilesPanel, formatBytes } from "./FilesPanel";

function meta(over: Partial<FileMeta> = {}): FileMeta {
  return { id: "f1", filename: "report.pdf", contentType: "application/pdf", size: 2048, createdAt: Date.parse("2026-01-02"), ...over };
}
function listing(over: Partial<FilesListing> = {}): FilesListing {
  return {
    files: [],
    usage: { count: 0, totalBytes: 0 },
    limits: { maxFileBytes: 26214400, maxTotalBytes: 209715200, maxCount: 200 },
    ...over,
  };
}

beforeEach(() => {
  listFiles.mockReset().mockResolvedValue(listing());
  deleteFile.mockReset().mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("formatBytes", () => {
  test("formats bytes across units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});

describe("FilesPanel — listing", () => {
  test("shows the empty state when there are no files", async () => {
    render(<FilesPanel onClose={() => {}} />);
    expect(await screen.findByText("No files yet.")).toBeInTheDocument();
    // The usage line renders once the listing loads (0 of 200 files - 0 B used).
    expect(await screen.findByText(/0 of 200 files/)).toBeInTheDocument();
  });

  test("lists files with size, date, and a download link", async () => {
    listFiles.mockResolvedValue(listing({ files: [meta({ filename: "photo.png", size: 1024 })], usage: { count: 1, totalBytes: 1024 } }));
    render(<FilesPanel onClose={() => {}} />);
    expect(await screen.findByText("photo.png")).toBeInTheDocument();
    expect(screen.getByText("1.0 KB")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Download" });
    expect(link).toHaveAttribute("href", "/api/files/f1");
    expect(link).toHaveAttribute("download", "photo.png");
  });

  test("shows a load error when the listing fetch fails", async () => {
    listFiles.mockRejectedValue(new Error("boom"));
    render(<FilesPanel onClose={() => {}} />);
    expect(await screen.findByText("Could not load your files.")).toBeInTheDocument();
  });
});

describe("FilesPanel — delete", () => {
  const two = () =>
    listing({
      files: [meta({ id: "f1", filename: "a.txt" }), meta({ id: "f2", filename: "b.txt" })],
      usage: { count: 2, totalBytes: 4096 },
    });

  test("select a file + Delete selected removes it (after confirm) and refreshes", async () => {
    listFiles
      .mockResolvedValueOnce(two())
      .mockResolvedValueOnce(listing({ files: [meta({ id: "f2", filename: "b.txt" })], usage: { count: 1, totalBytes: 2048 } }));
    render(<FilesPanel onClose={() => {}} />);
    await screen.findByText("a.txt");
    await userEvent.click(screen.getByRole("checkbox", { name: "a.txt" }));
    await userEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    expect(deleteFile).toHaveBeenCalledWith("f1");
    expect(deleteFile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("a.txt")).toBeNull());
  });

  test("select-all + Delete all removes every file", async () => {
    listFiles.mockResolvedValueOnce(two()).mockResolvedValueOnce(listing());
    render(<FilesPanel onClose={() => {}} />);
    await screen.findByText("a.txt");
    await userEvent.click(screen.getByRole("button", { name: "Delete all" }));
    expect(deleteFile).toHaveBeenCalledWith("f1");
    expect(deleteFile).toHaveBeenCalledWith("f2");
    await waitFor(() => expect(screen.getByText("No files yet.")).toBeInTheDocument());
  });

  test("the select-all header checkbox selects then clears every row", async () => {
    listFiles.mockResolvedValue(two());
    render(<FilesPanel onClose={() => {}} />);
    await screen.findByText("a.txt");
    await userEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByRole("checkbox", { name: "a.txt" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "b.txt" })).toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByRole("checkbox", { name: "a.txt" })).not.toBeChecked();
  });

  test("declining the confirm deletes nothing", async () => {
    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    listFiles.mockResolvedValue(two());
    render(<FilesPanel onClose={() => {}} />);
    await screen.findByText("a.txt");
    await userEvent.click(screen.getByRole("checkbox", { name: "a.txt" }));
    await userEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    expect(deleteFile).not.toHaveBeenCalled();
  });

  test("surfaces an error when a delete fails", async () => {
    listFiles.mockResolvedValue(two());
    deleteFile.mockRejectedValue(new Error("nope"));
    render(<FilesPanel onClose={() => {}} />);
    await screen.findByText("a.txt");
    await userEvent.click(screen.getByRole("checkbox", { name: "a.txt" }));
    await userEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    expect(await screen.findByText("Couldn't delete some files. Please try again.")).toBeInTheDocument();
  });

  test("lists a note that deleting won't affect conversations", async () => {
    listFiles.mockResolvedValue(two());
    render(<FilesPanel onClose={() => {}} />);
    expect(await screen.findByText(/won't remove it from conversations/)).toBeInTheDocument();
  });
});

describe("FilesPanel — close", () => {
  test("the close button + overlay click both dismiss", async () => {
    const onClose = vi.fn();
    const { container } = render(<FilesPanel onClose={onClose} />);
    await screen.findByText("No files yet.");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Clicking the panel body itself does NOT close (stopPropagation); the overlay does.
    fireEvent.click(container.querySelector(".panel")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector(".overlay")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
