import { describe, expect, test } from "vitest";
import { errorKey, type ErrorInfo, isNetworkError } from "./errors";

// errors.ts is the pure cause -> message-key mapper behind every inline ⚠️ note. These pin
// each branch of errorKey() and the isNetworkError() classifier so the UI can't regress
// back to leaking raw statuses / `e.message`. No DOM, no i18n runtime — just the mapping.

describe("errorKey", () => {
  test("network beats everything", () => {
    expect(errorKey({ network: true })).toBe("error.network");
    // Even with a status alongside, the network flag wins (we never reached the server).
    expect(errorKey({ network: true, status: 500 })).toBe("error.network");
  });

  test("429 without 'in progress' is a rate limit", () => {
    expect(errorKey({ status: 429 })).toBe("error.rateLimit");
    expect(errorKey({ status: 429, serverMessage: "rate limit exceeded -- slow down" })).toBe("error.rateLimit");
  });

  test("429 with 'in progress' is the already-generating case", () => {
    expect(errorKey({ status: 429, serverMessage: "a generation is already in progress" })).toBe("error.generating");
  });

  test("402 maps to the usage-limit message", () => {
    expect(errorKey({ status: 402 })).toBe("error.usageLimit");
  });

  test("401 maps to the expired-session message", () => {
    expect(errorKey({ status: 401 })).toBe("error.session");
  });

  test("403 maps to the not-available message", () => {
    expect(errorKey({ status: 403 })).toBe("error.notAvailable");
  });

  test("5xx maps to the server message", () => {
    expect(errorKey({ status: 500 })).toBe("error.server");
    expect(errorKey({ status: 503 })).toBe("error.server");
  });

  test("a mid-stream error frame maps to the stream message", () => {
    expect(errorKey({ kind: "stream" })).toBe("error.stream");
    // A generic stream frame routes by kind; a bare "model" mention that isn't a not-found signal
    // (no 404, no "not found"/"does not exist"/"unknown") stays the generic stream message.
    expect(errorKey({ kind: "stream", serverMessage: "model exploded" })).toBe("error.stream");
    expect(errorKey({ kind: "stream", serverMessage: "connection reset" })).toBe("error.stream");
  });

  test("a mid-stream 'model not served' error maps to the model-specific message", () => {
    // The shared parser formats an upstream rejection as `<label> -> <status>: <detail>`.
    expect(errorKey({ kind: "stream", serverMessage: `chat -> 404: {"error":"model 'qwen-chat' not found"}` })).toBe(
      "error.modelNotServed",
    );
    expect(errorKey({ kind: "stream", serverMessage: "the model does not exist" })).toBe("error.modelNotServed");
    expect(errorKey({ kind: "stream", serverMessage: "unknown model: qwen-omni" })).toBe("error.modelNotServed");
  });

  test("an unrecognized status (400) and an empty info fall through to generic", () => {
    expect(errorKey({ status: 400 })).toBe("error.generic");
    expect(errorKey({})).toBe("error.generic");
  });

  test("network ranks above a stream kind", () => {
    expect(errorKey({ network: true, kind: "stream" })).toBe("error.network");
  });

  test("a known status ranks above a stream kind", () => {
    // status is checked before kind, so a 500 that also carried a stream kind is a server error.
    expect(errorKey({ status: 500, kind: "stream" } satisfies ErrorInfo)).toBe("error.server");
  });
});

describe("isNetworkError", () => {
  test("a TypeError is a network error (fetch transport failure)", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
  });

  test("an Error whose message matches the network pattern is a network error", () => {
    expect(isNetworkError(new Error("Failed to fetch"))).toBe(true);
    expect(isNetworkError(new Error("NetworkError when attempting to fetch resource"))).toBe(true);
    expect(isNetworkError(new Error("Load failed"))).toBe(true);
  });

  test("a bare string that matches counts too", () => {
    expect(isNetworkError("network down")).toBe(true);
  });

  test("a non-network Error is not a network error", () => {
    expect(isNetworkError(new Error("rate limit exceeded"))).toBe(false);
  });

  test("a non-error value is not a network error", () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError({ status: 500 })).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});
