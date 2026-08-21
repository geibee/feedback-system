export type FeedbackMapLibreEvidenceMap = {
  getCanvas(): HTMLCanvasElement;
  on(event: "render", listener: () => void): unknown;
  off(event: "render", listener: () => void): unknown;
  triggerRepaint(): void;
};

export function validateMapLibreEvidenceMap(map: FeedbackMapLibreEvidenceMap): FeedbackMapLibreEvidenceMap {
  if (!map || typeof map !== "object" || typeof map.getCanvas !== "function" ||
    typeof map.on !== "function" || typeof map.off !== "function" || typeof map.triggerRepaint !== "function") {
    throw new Error("登録対象がMapLibre mapの証跡取得契約に適合しません");
  }
  return map;
}
