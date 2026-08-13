import {
  bindMapLibreFeedbackPins,
  captureReadyCanvasContextAttributes,
  createMapLibreEvidenceProvider,
  findUnreadableMapCanvases,
  resolveMapLibreFeedbackTarget,
  resolveMapLibreFeedbackTargetAtClientPoint
} from "@feedback/maplibre";

type Binding = ReturnType<typeof bindMapLibreFeedbackPins>;
type Target = ReturnType<typeof resolveMapLibreFeedbackTarget>;
type EvidenceProviderFactory = typeof createMapLibreEvidenceProvider;
type UnreadableCanvasFinder = typeof findUnreadableMapCanvases;
type ClientPointResolver = typeof resolveMapLibreFeedbackTargetAtClientPoint;

export type MapLibrePackageSmoke = {
  binding: Binding;
  target: Target;
  evidenceProviderFactory: EvidenceProviderFactory;
  unreadableCanvasFinder: UnreadableCanvasFinder;
  clientPointResolver: ClientPointResolver;
};

export const mapLibreCaptureContextAttributes = captureReadyCanvasContextAttributes;
