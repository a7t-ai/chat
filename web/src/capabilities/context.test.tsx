import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { CapabilityProvider, useOpenCapability } from "./context";

// The capability context lets a deep inline Chip raise its payload to the canvas without
// prop-threading. These lock the default no-op (so an un-provided tree never throws on click)
// and that the provided open() flows through.

describe("useOpenCapability", () => {
  test("returns a safe no-op when no provider is mounted", () => {
    const { result } = renderHook(() => useOpenCapability());
    expect(typeof result.current).toBe("function");
    expect(() => result.current("map", "anything")).not.toThrow();
  });

  test("returns the provided open() from the nearest provider", () => {
    const open = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <CapabilityProvider value={open}>{children}</CapabilityProvider>
    );
    const { result } = renderHook(() => useOpenCapability(), { wrapper });
    result.current("map", "Lisbon");
    expect(open).toHaveBeenCalledWith("map", "Lisbon");
  });
});
