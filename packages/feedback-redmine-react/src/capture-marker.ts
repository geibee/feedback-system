import type { FeedbackEvidencePayload } from "@geibee/feedback-core";

export type FeedbackCaptureMarkerPosition = { x: number; y: number };

type CaptureMarkerRenderer = (
  payload: FeedbackEvidencePayload,
  position: FeedbackCaptureMarkerPosition
) => Promise<Uint8Array>;

/** 取得済み証跡へ、選択位置を示すFeedbackピンを焼き込む。 */
export async function addFeedbackCaptureMarker(
  payload: FeedbackEvidencePayload,
  position: FeedbackCaptureMarkerPosition,
  render: CaptureMarkerRenderer = renderFeedbackCaptureMarker
): Promise<FeedbackEvidencePayload> {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new Error("フィードバック位置をスクリーンショットへ描画できませんでした");
  }
  return { ...payload, bytes: await render(payload, position) };
}

async function renderFeedbackCaptureMarker(
  payload: FeedbackEvidencePayload,
  position: FeedbackCaptureMarkerPosition
): Promise<Uint8Array> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    throw new Error("このブラウザはスクリーンショットへの位置表示に対応していません");
  }
  const source = new Blob([Uint8Array.from(payload.bytes).buffer], { type: payload.contentType });
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("スクリーンショットへの位置表示を初期化できませんでした");
    context.drawImage(bitmap, 0, 0);
    const scaleX = bitmap.width / Math.max(1, payload.viewportWidth);
    const scaleY = bitmap.height / Math.max(1, payload.viewportHeight);
    drawFeedbackPin(context, position.x * scaleX, position.y * scaleY, Math.max(1, Math.min(scaleX, scaleY)));
    const output = await encodeCanvas(canvas, payload.contentType);
    if (output.type !== payload.contentType) {
      throw new Error("スクリーンショットを元の画像形式で保存できませんでした");
    }
    return new Uint8Array(await output.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function drawFeedbackPin(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number
): void {
  const unit = Math.max(0.75, scale);
  context.save();
  context.beginPath();
  context.moveTo(x, y);
  context.bezierCurveTo(x - 3 * unit, y - 7 * unit, x - 12 * unit, y - 11 * unit, x - 12 * unit, y - 20 * unit);
  context.bezierCurveTo(x - 12 * unit, y - 28 * unit, x - 7 * unit, y - 33 * unit, x, y - 33 * unit);
  context.bezierCurveTo(x + 7 * unit, y - 33 * unit, x + 12 * unit, y - 28 * unit, x + 12 * unit, y - 20 * unit);
  context.bezierCurveTo(x + 12 * unit, y - 11 * unit, x + 3 * unit, y - 7 * unit, x, y);
  context.closePath();
  context.fillStyle = "#dc2626";
  context.fill();
  context.lineWidth = 2 * unit;
  context.strokeStyle = "#ffffff";
  context.stroke();

  // 白い吹き出しで、既存thread pinと未投稿位置を区別する。
  const bubbleY = y - 25 * unit;
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.roundRect(x - 7 * unit, bubbleY - 4 * unit, 14 * unit, 9 * unit, 3 * unit);
  context.fill();
  context.beginPath();
  context.moveTo(x - 3 * unit, bubbleY + 4 * unit);
  context.lineTo(x - 5 * unit, bubbleY + 8 * unit);
  context.lineTo(x + 1 * unit, bubbleY + 4 * unit);
  context.closePath();
  context.fill();
  context.restore();
}

function encodeCanvas(canvas: HTMLCanvasElement, contentType: FeedbackEvidencePayload["contentType"]): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("位置表示付きスクリーンショットを生成できませんでした"));
    }, contentType);
  });
}
