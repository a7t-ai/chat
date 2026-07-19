import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { Recap } from "./api";
import { useRecapRunner } from "./useRecapRunner";

const RECAP: Recap = { topic: "Trip to Lisbon", progress: ["Chose May"], whereItEnded: "Comparing hotels" };

// A promise we resolve/reject by hand, so a test can observe the in-flight `recapping` window.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useRecapRunner", () => {
  test("recapping is false at rest", () => {
    const { result } = renderHook(() =>
      useRecapRunner({ onRecap: vi.fn(), onEmpty: vi.fn(), onError: vi.fn(), forceRecap: vi.fn() }),
    );
    expect(result.current.recapping).toBe(false);
  });

  test("sets recapping true during the await and false after a recap arrives", async () => {
    const d = deferred<Recap | null>();
    const forceRecap = vi.fn(() => d.promise);
    const onRecap = vi.fn();
    const onEmpty = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useRecapRunner({ onRecap, onEmpty, onError, forceRecap }));

    let done!: Promise<void>;
    act(() => {
      done = result.current.runRecap("c1");
    });
    // In flight: the indicator is on and the request went out.
    expect(result.current.recapping).toBe(true);
    expect(forceRecap).toHaveBeenCalledWith("c1");

    await act(async () => {
      d.resolve(RECAP);
      await done;
    });
    expect(result.current.recapping).toBe(false);
    expect(onRecap).toHaveBeenCalledWith(RECAP);
    expect(onEmpty).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test("clears recapping and reports empty when there is nothing to recap (null)", async () => {
    const forceRecap = vi.fn(async () => null);
    const onRecap = vi.fn();
    const onEmpty = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useRecapRunner({ onRecap, onEmpty, onError, forceRecap }));

    await act(async () => {
      await result.current.runRecap("c1");
    });
    expect(result.current.recapping).toBe(false);
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(onRecap).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test("clears recapping and reports failure when forceRecap throws", async () => {
    const forceRecap = vi.fn(async () => {
      throw new Error("boom");
    });
    const onRecap = vi.fn();
    const onEmpty = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useRecapRunner({ onRecap, onEmpty, onError, forceRecap }));

    await act(async () => {
      await result.current.runRecap("c1");
    });
    // The finally still runs on a throw - never a stuck "Recapping...".
    expect(result.current.recapping).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onRecap).not.toHaveBeenCalled();
    expect(onEmpty).not.toHaveBeenCalled();
  });

  test("ignores a second /recap while one is already generating", async () => {
    const d = deferred<Recap | null>();
    const forceRecap = vi.fn(() => d.promise);
    const onRecap = vi.fn();
    const { result } = renderHook(() =>
      useRecapRunner({ onRecap, onEmpty: vi.fn(), onError: vi.fn(), forceRecap }),
    );

    let first!: Promise<void>;
    act(() => {
      first = result.current.runRecap("c1");
    });
    expect(result.current.recapping).toBe(true);

    // A repeat while in flight is a no-op: no second request, still one run.
    await act(async () => {
      await result.current.runRecap("c1");
    });
    expect(forceRecap).toHaveBeenCalledTimes(1);
    expect(result.current.recapping).toBe(true);

    await act(async () => {
      d.resolve(RECAP);
      await first;
    });
    expect(result.current.recapping).toBe(false);
    expect(onRecap).toHaveBeenCalledTimes(1);
  });
});
