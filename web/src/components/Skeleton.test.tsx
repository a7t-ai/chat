import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ConvoListSkeleton, MapDrawerSkeleton, ThreadSkeleton } from "./Skeleton";

// The three shimmer placeholders are pure markup. Assert the row counts they emit and the
// presence of the structural classes the CSS animates, so a refactor that drops a row or a
// hook class is caught.

describe("ConvoListSkeleton", () => {
  test("renders the default 6 rows", () => {
    const { container } = render(<ConvoListSkeleton />);
    expect(container.querySelectorAll("li.skeleton-row")).toHaveLength(6);
    expect(container.querySelector("ul.skeleton-list")).toHaveAttribute("aria-hidden", "true");
  });

  test("honors a custom row count", () => {
    const { container } = render(<ConvoListSkeleton rows={3} />);
    expect(container.querySelectorAll("li.skeleton-row")).toHaveLength(3);
  });

  test("each row has a mark and two bars", () => {
    const { container } = render(<ConvoListSkeleton rows={1} />);
    expect(container.querySelector(".sk-mark")).not.toBeNull();
    expect(container.querySelectorAll(".sk-bar")).toHaveLength(2);
  });
});

describe("ThreadSkeleton", () => {
  test("renders the four scripted message blocks", () => {
    const { container } = render(<ThreadSkeleton />);
    expect(container.querySelectorAll(".skeleton-msg")).toHaveLength(4);
    // The script alternates user/assistant.
    expect(container.querySelectorAll(".msg.user")).toHaveLength(2);
    expect(container.querySelectorAll(".msg.assistant")).toHaveLength(2);
  });
});

describe("MapDrawerSkeleton", () => {
  test("mirrors the real drawer's inner content (header + map area + four pins), no second aside", () => {
    const { container } = render(<MapDrawerSkeleton />);
    // Inner content only — the animated .cap-drawer aside is owned by the shell, so the
    // skeleton -> map swap happens INSIDE it with no second slide-in.
    expect(container.querySelector("aside")).toBeNull();
    expect(container.querySelector(".cap-drawer-head")).not.toBeNull();
    expect(container.querySelector(".map-canvas.map-skeleton")).not.toBeNull();
    expect(container.querySelectorAll(".map-skeleton-pill")).toHaveLength(4);
  });
});
