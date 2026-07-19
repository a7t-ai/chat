import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  currentConversationId,
  currentShareSlug,
  isKnownRoute,
  navigateToConversation,
  navigateToNew,
} from "./route";

// Routing is a hand-rolled regex over location.pathname + history.pushState. jsdom gives us
// a real (in-memory) history, so we can drive the URL and read it back. These lock the parse
// (incl. encoded ids) and the "don't push a duplicate entry" guard.

function setPath(path: string) {
  window.history.replaceState({}, "", path);
}

beforeEach(() => setPath("/"));
afterEach(() => setPath("/"));

describe("currentConversationId", () => {
  test("returns the id for /c/{id}", () => {
    setPath("/c/abc123");
    expect(currentConversationId()).toBe("abc123");
  });

  test("tolerates a trailing slash", () => {
    setPath("/c/abc123/");
    expect(currentConversationId()).toBe("abc123");
  });

  test("decodes a percent-encoded id", () => {
    setPath("/c/a%2Fb");
    expect(currentConversationId()).toBe("a/b");
  });

  test("returns null at the root", () => {
    setPath("/");
    expect(currentConversationId()).toBeNull();
  });

  test("returns null for an unrelated path", () => {
    setPath("/settings");
    expect(currentConversationId()).toBeNull();
  });

  test("returns null for a nested path under /c (not a single segment)", () => {
    setPath("/c/abc/extra");
    expect(currentConversationId()).toBeNull();
  });
});

describe("navigateToConversation", () => {
  test("pushes /c/{id} and encodes the id", () => {
    navigateToConversation("a/b");
    expect(window.location.pathname).toBe("/c/a%2Fb");
    expect(currentConversationId()).toBe("a/b");
  });

  test("does not push a new entry when already on that conversation", () => {
    setPath("/c/same");
    const len = window.history.length;
    navigateToConversation("same");
    expect(window.history.length).toBe(len);
    expect(window.location.pathname).toBe("/c/same");
  });

  test("replace mode swaps the current entry instead of pushing", () => {
    setPath("/c/old");
    const len = window.history.length;
    navigateToConversation("new", true);
    expect(window.location.pathname).toBe("/c/new");
    expect(window.history.length).toBe(len); // replaceState, not pushState
  });
});

describe("navigateToNew", () => {
  test("navigates to root from a conversation", () => {
    setPath("/c/abc");
    navigateToNew();
    expect(window.location.pathname).toBe("/");
  });

  test("is a no-op when already at root", () => {
    setPath("/");
    const len = window.history.length;
    navigateToNew();
    expect(window.location.pathname).toBe("/");
    expect(window.history.length).toBe(len);
  });

  test("replace mode swaps instead of pushing", () => {
    setPath("/c/abc");
    const len = window.history.length;
    navigateToNew(true);
    expect(window.location.pathname).toBe("/");
    expect(window.history.length).toBe(len);
  });
});

describe("currentShareSlug", () => {
  function setPath(path: string) {
    window.history.replaceState({}, "", path);
  }

  test("returns the slug for /s/{slug}", () => {
    setPath("/s/abc123");
    expect(currentShareSlug()).toBe("abc123");
  });

  test("tolerates a trailing slash", () => {
    setPath("/s/abc123/");
    expect(currentShareSlug()).toBe("abc123");
  });

  test("decodes a percent-encoded slug", () => {
    setPath("/s/a%2Fb");
    expect(currentShareSlug()).toBe("a/b");
  });

  test("returns null at the root and for unrelated paths", () => {
    setPath("/");
    expect(currentShareSlug()).toBeNull();
    setPath("/c/abc");
    expect(currentShareSlug()).toBeNull();
  });

  test("returns null for a nested path under /s (not a single segment)", () => {
    setPath("/s/abc/extra");
    expect(currentShareSlug()).toBeNull();
  });
});

describe("isKnownRoute", () => {
  function setPath(path: string) {
    window.history.replaceState({}, "", path);
  }

  test.each(["/", "/help", "/design-system"])("is true for the static route %s", (p) => {
    setPath(p);
    expect(isKnownRoute()).toBe(true);
  });

  test("is true for a conversation and a share page", () => {
    setPath("/c/abc123");
    expect(isKnownRoute()).toBe(true);
    setPath("/s/slug123");
    expect(isKnownRoute()).toBe(true);
  });

  test("is false for an unknown path", () => {
    setPath("/dasda");
    expect(isKnownRoute()).toBe(false);
  });

  // The removed hosted-SaaS surfaces are no longer routes → they must 404, not boot the app.
  test.each(["/privacy", "/imprint", "/changelog", "/terms"])("is false for the removed route %s", (p) => {
    setPath(p);
    expect(isKnownRoute()).toBe(false);
  });

  test("is false for a trailing slash on a static route (exact match only)", () => {
    setPath("/help/");
    expect(isKnownRoute()).toBe(false);
  });

  test("is false for a nested path under /c (not a single segment)", () => {
    setPath("/c/abc/extra");
    expect(isKnownRoute()).toBe(false);
  });
});
