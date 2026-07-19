import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dragHasFiles, filesFromDataTransfer, MAX_ATTACHMENTS, modelAcceptsAttachments, useAttachments } from "./attachments";

// The upload seam is mocked — these tests exercise the pure drag helpers and the hook's
// optimistic add -> ready/error transitions + object-URL lifecycle, never the network.
const uploadFile = vi.fn();
vi.mock("./api", () => ({
  uploadFile: (f: File) => uploadFile(f),
}));

function file(name: string, type = "text/plain", size = 3): File {
  const f = new File(["abc"], name, { type });
  // jsdom derives size from the blob parts; pin it so assertions are stable.
  Object.defineProperty(f, "size", { value: size });
  return f;
}

// A minimal DataTransfer-ish object; jsdom's real DataTransfer is inert for files.
function dt(over: Partial<DataTransfer> & { types?: string[] }): DataTransfer {
  return { types: [], files: [] as unknown as FileList, items: null, ...over } as unknown as DataTransfer;
}

beforeEach(() => {
  vi.clearAllMocks();
  uploadFile.mockResolvedValue({ ok: true, file: { id: "srv1", filename: "x", contentType: "text/plain", size: 3, createdAt: 0 } });
  // jsdom has no object-URL support — stub both sides so the hook can mint/revoke previews.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:preview"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dragHasFiles", () => {
  test("true only when the drag advertises the Files type", () => {
    expect(dragHasFiles(dt({ types: ["Files"] }))).toBe(true);
    expect(dragHasFiles(dt({ types: ["text/plain", "Files"] }))).toBe(true);
    expect(dragHasFiles(dt({ types: ["text/plain"] }))).toBe(false);
    expect(dragHasFiles(dt({ types: [] }))).toBe(false);
  });

  test("false for a null/undefined dataTransfer or missing types", () => {
    expect(dragHasFiles(null)).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
    expect(dragHasFiles({ } as unknown as DataTransfer)).toBe(false);
  });
});

describe("filesFromDataTransfer", () => {
  test("returns nothing for a null dataTransfer", () => {
    expect(filesFromDataTransfer(null)).toEqual([]);
  });

  test("prefers .files when present", () => {
    const f = file("a.png", "image/png");
    const list = [f] as unknown as FileList;
    expect(filesFromDataTransfer(dt({ files: list }))).toEqual([f]);
  });

  test("falls back to .items, keeping only file-kind entries", () => {
    const f = file("b.txt");
    const items = [
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => f },
      { kind: "file", getAsFile: () => null }, // a file item that yields nothing is skipped
    ];
    const got = filesFromDataTransfer(dt({ files: [] as unknown as FileList, items: items as unknown as DataTransferItemList }));
    expect(got).toEqual([f]);
  });
});

describe("modelAcceptsAttachments", () => {
  test("true when the model has a non-text input modality (Omni)", () => {
    expect(modelAcceptsAttachments(["text", "image"])).toBe(true);
    expect(modelAcceptsAttachments(["text", "audio", "video"])).toBe(true);
    expect(modelAcceptsAttachments(["audio"])).toBe(true);
    expect(modelAcceptsAttachments(["document"])).toBe(true);
  });

  test("false for a text-only model", () => {
    expect(modelAcceptsAttachments(["text"])).toBe(false);
    expect(modelAcceptsAttachments([])).toBe(false);
  });

  test("optimistic (true) while the catalog is unknown", () => {
    expect(modelAcceptsAttachments(undefined)).toBe(true);
  });
});

describe("useAttachments — per-message cap (#136)", () => {
  function files(n: number): File[] {
    return Array.from({ length: n }, (_, i) => new File(["abc"], `f${i}.txt`, { type: "text/plain" }));
  }

  test("caps the list at MAX_ATTACHMENTS and flags the overflow", () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.addFiles(files(MAX_ATTACHMENTS + 3)));
    expect(result.current.items).toHaveLength(MAX_ATTACHMENTS);
    expect(result.current.limitHit).toBe(true);
  });

  test("adding exactly the cap does not flag a limit", () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.addFiles(files(MAX_ATTACHMENTS)));
    expect(result.current.items).toHaveLength(MAX_ATTACHMENTS);
    expect(result.current.limitHit).toBe(false);
  });

  test("a full list refuses any further add and keeps the flag", () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.addFiles(files(MAX_ATTACHMENTS)));
    act(() => result.current.addFiles(files(1)));
    expect(result.current.items).toHaveLength(MAX_ATTACHMENTS);
    expect(result.current.limitHit).toBe(true);
  });

  test("removing a capped file frees a slot and clears the flag", () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.addFiles(files(MAX_ATTACHMENTS + 1)));
    expect(result.current.limitHit).toBe(true);
    act(() => result.current.remove(result.current.items[0].localId));
    expect(result.current.items).toHaveLength(MAX_ATTACHMENTS - 1);
    expect(result.current.limitHit).toBe(false);
  });

  test("an empty add is a no-op (never flags a limit)", () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.addFiles([]));
    expect(result.current.items).toHaveLength(0);
    expect(result.current.limitHit).toBe(false);
  });
});

describe("useAttachments", () => {
  test("optimistically adds an uploading chip, then marks it ready with the server id", async () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.addFiles([file("doc.txt")]));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({ name: "doc.txt", status: "uploading", isImage: false });
    await waitFor(() => expect(result.current.items[0].status).toBe("ready"));
    expect(result.current.items[0].fileId).toBe("srv1");
  });

  test("mints an object-URL preview for image files", async () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.addFiles([file("pic.png", "image/png")]));
    expect(result.current.items[0].isImage).toBe(true);
    expect(result.current.items[0].previewUrl).toBe("blob:preview");
    await waitFor(() => expect(result.current.items[0].status).toBe("ready"));
  });

  test("maps a rejected upload to an error reason", async () => {
    uploadFile.mockResolvedValue({ ok: false, reason: "too_large" });
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.addFiles([file("big.bin")]));
    await waitFor(() => expect(result.current.items[0].status).toBe("error"));
    expect(result.current.items[0].errorReason).toBe("too_large");
  });

  test("maps a thrown upload to the generic error", async () => {
    uploadFile.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.addFiles([file("x.bin")]));
    await waitFor(() => expect(result.current.items[0].status).toBe("error"));
    expect(result.current.items[0].errorReason).toBe("error");
  });

  test("remove drops the chip and revokes its preview URL", async () => {
    const revoke = (globalThis.URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>);
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.addFiles([file("pic.png", "image/png")]));
    const id = result.current.items[0].localId;
    act(() => result.current.remove(id));
    expect(result.current.items).toHaveLength(0);
    expect(revoke).toHaveBeenCalledWith("blob:preview");
  });

  test("clear empties the list and revokes every preview", async () => {
    const revoke = (globalThis.URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>);
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.addFiles([file("a.png", "image/png"), file("b.png", "image/png")]));
    expect(result.current.items).toHaveLength(2);
    act(() => result.current.clear());
    expect(result.current.items).toHaveLength(0);
    expect(revoke).toHaveBeenCalled();
  });

  test("survives when object URLs are unavailable (no thumbnail, still adds)", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => {
        throw new Error("unsupported");
      }),
      revokeObjectURL: vi.fn(),
    });
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.addFiles([file("pic.png", "image/png")]));
    expect(result.current.items[0].previewUrl).toBeUndefined();
    await waitFor(() => expect(result.current.items[0].status).toBe("ready"));
  });
});
