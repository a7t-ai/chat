import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConversationMeta } from "../lib/api";
import { installLocalStorage } from "../__tests__/localStorage";
import { ConvoItem } from "./ConvoItem";

beforeEach(() => installLocalStorage());

function meta(over: Partial<ConversationMeta> = {}): ConversationMeta {
  return { id: "c1", title: "Trip to Lisbon", model: "m", starred: false, updatedAt: 0, ...over };
}

function setup(over: Partial<ConversationMeta> = {}, props: Partial<Parameters<typeof ConvoItem>[0]> = {}) {
  const handlers = {
    onOpen: vi.fn(),
    onRename: vi.fn(),
    onGenerateTitle: vi.fn(),
    onToggleStar: vi.fn(),
    onDelete: vi.fn(),
  };
  render(<ConvoItem convo={meta(over)} active={false} {...handlers} {...props} />);
  return handlers;
}

describe("ConvoItem", () => {
  test("opens on click and shows the title", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /Trip to Lisbon/ }));
    expect(h.onOpen).toHaveBeenCalledTimes(1);
  });

  test("falls back to the Untitled label when title is null", () => {
    setup({ title: null });
    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });

  test("shows the generating spinner when generating", () => {
    setup({}, { generating: true });
    expect(screen.getByLabelText("Generating")).toBeInTheDocument();
  });

  test("the options menu toggles open and closed", async () => {
    setup();
    const dots = screen.getByLabelText("Conversation options");
    expect(dots).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(dots);
    expect(dots).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Rename")).toBeInTheDocument();
    await userEvent.click(dots);
    expect(screen.queryByText("Rename")).toBeNull();
  });

  test("star menu item fires onToggleStar and shows Star/Unstar by state", async () => {
    const h = setup({ starred: false });
    await userEvent.click(screen.getByLabelText("Conversation options"));
    const star = screen.getByText("Star");
    await userEvent.click(star);
    expect(h.onToggleStar).toHaveBeenCalledTimes(1);
  });

  test("shows Unstar when already starred", async () => {
    setup({ starred: true });
    await userEvent.click(screen.getByLabelText("Conversation options"));
    expect(screen.getByText("Unstar")).toBeInTheDocument();
  });

  test("generate-title menu item fires onGenerateTitle and closes the menu", async () => {
    const h = setup();
    await userEvent.click(screen.getByLabelText("Conversation options"));
    await userEvent.click(screen.getByText("Generate title"));
    expect(h.onGenerateTitle).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Generate title")).toBeNull();
  });

  test("delete menu item fires onDelete", async () => {
    const h = setup();
    await userEvent.click(screen.getByLabelText("Conversation options"));
    await userEvent.click(screen.getByText("Delete"));
    expect(h.onDelete).toHaveBeenCalledTimes(1);
  });

  test("double-click enters inline rename, Enter commits a changed title", () => {
    const h = setup();
    fireEvent.doubleClick(screen.getByRole("button", { name: /Trip to Lisbon/ }));
    const input = screen.getByLabelText("Conversation name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onRename).toHaveBeenCalledWith("New name");
  });

  test("rename does not fire when the value is unchanged", () => {
    const h = setup();
    fireEvent.doubleClick(screen.getByRole("button", { name: /Trip to Lisbon/ }));
    const input = screen.getByLabelText("Conversation name");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onRename).not.toHaveBeenCalled();
  });

  test("Escape cancels rename without committing", () => {
    const h = setup();
    fireEvent.doubleClick(screen.getByRole("button", { name: /Trip to Lisbon/ }));
    const input = screen.getByLabelText("Conversation name");
    fireEvent.change(input, { target: { value: "discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(h.onRename).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Conversation name")).toBeNull();
  });

  test("blur commits the rename once (guarded against double-commit)", () => {
    const h = setup();
    fireEvent.doubleClick(screen.getByRole("button", { name: /Trip to Lisbon/ }));
    const input = screen.getByLabelText("Conversation name");
    fireEvent.change(input, { target: { value: "Blurred name" } });
    fireEvent.blur(input);
    expect(h.onRename).toHaveBeenCalledTimes(1);
    expect(h.onRename).toHaveBeenCalledWith("Blurred name");
  });

  test("rename from the menu also enters edit mode", async () => {
    setup();
    await userEvent.click(screen.getByLabelText("Conversation options"));
    await userEvent.click(screen.getByText("Rename"));
    expect(screen.getByLabelText("Conversation name")).toBeInTheDocument();
  });

  test("clicking outside the menu closes it", async () => {
    setup();
    await userEvent.click(screen.getByLabelText("Conversation options"));
    expect(screen.getByText("Rename")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText("Rename")).toBeNull();
  });

  test("applies the active class when active", () => {
    const { container } = render(
      <ConvoItem
        convo={meta()}
        active
        onOpen={() => {}}
        onRename={() => {}}
        onGenerateTitle={() => {}}
        onToggleStar={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(container.querySelector("li.convo-item")).toHaveClass("active");
  });

  test("marks the active row with aria-current and leaves inactive rows unmarked", () => {
    const props = {
      convo: meta(),
      onOpen: () => {},
      onRename: () => {},
      onGenerateTitle: () => {},
      onToggleStar: () => {},
      onDelete: () => {},
    };
    const { rerender } = render(<ConvoItem {...props} active />);
    expect(screen.getByRole("button", { name: /Trip to Lisbon/ })).toHaveAttribute("aria-current", "true");
    rerender(<ConvoItem {...props} active={false} />);
    expect(screen.getByRole("button", { name: /Trip to Lisbon/ })).not.toHaveAttribute("aria-current");
  });

  test("menu items live inside the popover", async () => {
    setup();
    await userEvent.click(screen.getByLabelText("Conversation options"));
    const pop = document.querySelector(".convo-pop") as HTMLElement;
    expect(within(pop).getByText("Delete")).toBeInTheDocument();
  });

  test("is a drag source when draggable, firing onDragStart", () => {
    const onDragStart = vi.fn();
    const { container } = render(
      <ConvoItem
        convo={meta()}
        active={false}
        draggable
        onOpen={() => {}}
        onRename={() => {}}
        onGenerateTitle={() => {}}
        onToggleStar={() => {}}
        onDelete={() => {}}
        onDragStart={onDragStart}
      />,
    );
    const li = container.querySelector("li.convo-item") as HTMLElement;
    expect(li).toHaveAttribute("draggable", "true");
    expect(li).toHaveClass("draggable");
    fireEvent.dragStart(li);
    expect(onDragStart).toHaveBeenCalledTimes(1);
  });

  test("is not a drag source by default", () => {
    const { container } = render(
      <ConvoItem
        convo={meta()}
        active={false}
        onOpen={() => {}}
        onRename={() => {}}
        onGenerateTitle={() => {}}
        onToggleStar={() => {}}
        onDelete={() => {}}
      />,
    );
    const li = container.querySelector("li.convo-item") as HTMLElement;
    expect(li).toHaveAttribute("draggable", "false");
    expect(li).not.toHaveClass("draggable");
  });
});
