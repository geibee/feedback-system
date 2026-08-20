import { useEffect, useRef } from "react";

/** 旧React版と同じく、外側操作とEscapeで独立ペインを閉じる。 */
export function useDismissiblePanel<T extends HTMLElement>(onDismiss: () => void) {
  const panelRef = useRef<T>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    const pointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (!panel || event.composedPath().includes(panel)) return;
      onDismissRef.current();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismissRef.current();
    };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("keydown", keyDown);
    };
  }, []);
  return panelRef;
}
