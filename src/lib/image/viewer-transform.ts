export interface ViewTransform {
  zoom: number;
  x: number;
  y: number;
}

export interface ViewerSize {
  width: number;
  height: number;
}

export const MIN_VIEWER_ZOOM = 1;
export const MAX_VIEWER_ZOOM = 4;

/**
 * Keeps the zoom inside 1x-4x and bounds panning to the scaled image edges.
 * `fittedImage` is the displayed image size at 1x, not its original pixel size.
 */
export function clampViewerTransform(
  value: ViewTransform,
  viewport: ViewerSize,
  fittedImage: ViewerSize
): ViewTransform {
  const zoom = Math.min(MAX_VIEWER_ZOOM, Math.max(MIN_VIEWER_ZOOM, value.zoom));
  const maxX = Math.max(0, (fittedImage.width * zoom - viewport.width) / 2);
  const maxY = Math.max(0, (fittedImage.height * zoom - viewport.height) / 2);

  return {
    zoom,
    x: maxX === 0 ? 0 : Math.max(-maxX, Math.min(maxX, value.x)),
    y: maxY === 0 ? 0 : Math.max(-maxY, Math.min(maxY, value.y)),
  };
}
