import { useEffect, useRef } from "react";

export function useVisiblePolling(
  enabled: boolean,
  intervalMilliseconds: number,
  refresh: () => void | Promise<void>
): void {
  const current = useRef(refresh);
  current.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (!timer && document.visibilityState !== "hidden") {
        timer = setInterval(() => void current.current(), intervalMilliseconds);
      }
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") stop();
      else {
        void current.current();
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled, intervalMilliseconds]);
}
