import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVisiblePolling } from "./storage.js";

function Probe(props: { refresh: () => void }) {
  useVisiblePolling(true, 30_000, props.refresh);
  return null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("visible polling", () => {
  it("30秒周期、hidden停止、復帰時即時refresh、unmount cleanupを行う", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const view = render(<Probe refresh={refresh} />);
    act(() => vi.advanceTimersByTime(30_000));
    expect(refresh).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(90_000));
    expect(refresh).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(refresh).toHaveBeenCalledTimes(2);
    view.unmount();
    act(() => vi.advanceTimersByTime(90_000));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
