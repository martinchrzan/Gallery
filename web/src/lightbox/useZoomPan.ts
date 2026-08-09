import { useCallback, useEffect, useRef, useState } from 'react';

export const MAX_SCALE = 8;

/**
 * Maps a zoom level onto the 0–1 slider position and back, logarithmically so
 * each pixel of travel is the same *proportional* zoom change rather than the
 * top end hogging the track.
 */
export function scaleToSlider(scale: number, fitScale: number): number {
  if (MAX_SCALE <= fitScale) return 0;
  return Math.min(1, Math.max(0, Math.log(scale / fitScale) / Math.log(MAX_SCALE / fitScale)));
}

export function sliderToScale(position: number, fitScale: number): number {
  if (MAX_SCALE <= fitScale) return fitScale;
  return fitScale * (MAX_SCALE / fitScale) ** Math.min(1, Math.max(0, position));
}

/**
 * The view is stored as a scale plus a *focal point in image coordinates* — the
 * pixel of the photo pinned to the centre of the stage.
 *
 * Storing the translation directly instead would mean deriving each new
 * position from the previous, already-clamped one; the clamping error then
 * compounds across a drag and the photo visibly wanders. Anchoring on a focal
 * point makes every position absolute, so repeated small zoom steps land
 * exactly where a single large one would.
 */
interface View {
  scale: number;
  /** Focal point, in image pixels. */
  fx: number;
  fy: number;
}

export interface ZoomPanState {
  scale: number;
  /** Translation to render with, in stage pixels. */
  x: number;
  y: number;
  /** Scale at which the whole image fits the stage. */
  fitScale: number;
  panning: boolean;
  zoomed: boolean;
}

interface Options {
  stageWidth: number;
  stageHeight: number;
  imageWidth: number;
  imageHeight: number;
  /**
   * Identifies the subject. Changing it forces a re-fit even when the geometry
   * is unchanged — without it, moving to a photo that happens to have exactly
   * the same dimensions would silently inherit the previous photo's zoom.
   */
  resetKey?: string | number;
}

export function useZoomPan({
  stageWidth,
  stageHeight,
  imageWidth,
  imageHeight,
  resetKey,
}: Options) {
  // Never enlarge past 1:1 to fit — a small photo shows at its own size.
  const fitScale =
    imageWidth > 0 && imageHeight > 0 && stageWidth > 0 && stageHeight > 0
      ? Math.min(stageWidth / imageWidth, stageHeight / imageHeight, 1)
      : 1;

  const view = useRef<View>({ scale: fitScale, fx: imageWidth / 2, fy: imageHeight / 2 });
  const [state, setState] = useState<ZoomPanState>(() =>
    project(view.current, fitScale, stageWidth, stageHeight, false),
  );

  /**
   * Constrains the focal point so the photo never drifts away from the stage:
   * centred while it is smaller than the stage, and edge-bound once it is larger.
   */
  const clampFocus = useCallback(
    (next: View): View => {
      const axis = (focus: number, image: number, stage: number, scale: number): number => {
        if (image * scale <= stage) return image / 2;
        const margin = stage / (2 * scale);
        return Math.min(image - margin, Math.max(margin, focus));
      };
      return {
        scale: next.scale,
        fx: axis(next.fx, imageWidth, stageWidth, next.scale),
        fy: axis(next.fy, imageHeight, stageHeight, next.scale),
      };
    },
    [imageHeight, imageWidth, stageHeight, stageWidth],
  );

  const apply = useCallback(
    (next: View, panning = false) => {
      const clamped = clampFocus({
        scale: Math.min(MAX_SCALE, Math.max(fitScale, next.scale)),
        fx: next.fx,
        fy: next.fy,
      });
      view.current = clamped;
      setState(project(clamped, fitScale, stageWidth, stageHeight, panning));
    },
    [clampFocus, fitScale, stageHeight, stageWidth],
  );

  const reset = useCallback(() => {
    apply({ scale: fitScale, fx: imageWidth / 2, fy: imageHeight / 2 });
  }, [apply, fitScale, imageHeight, imageWidth]);

  // Re-fit when the stage or image geometry changes, and whenever the subject
  // changes even if its geometry happens to match the previous one.
  useEffect(reset, [reset, resetKey]);

  /** Zooms about a point in stage coordinates, keeping that pixel put. */
  const zoomAt = useCallback(
    (targetScale: number, pointX: number, pointY: number) => {
      const current = view.current;
      const scale = Math.min(MAX_SCALE, Math.max(fitScale, targetScale));

      // Image pixel currently under the pointer.
      const currentX = stageWidth / 2 - current.fx * current.scale;
      const currentY = stageHeight / 2 - current.fy * current.scale;
      const imageX = (pointX - currentX) / current.scale;
      const imageY = (pointY - currentY) / current.scale;

      apply({
        scale,
        fx: imageX + (stageWidth / 2 - pointX) / scale,
        fy: imageY + (stageHeight / 2 - pointY) / scale,
      });
    },
    [apply, fitScale, stageHeight, stageWidth],
  );

  /**
   * Jumps to an absolute scale about the stage centre. Because the focal point
   * is left untouched, dragging the slider is perfectly steady.
   */
  const zoomTo = useCallback(
    (scale: number) => apply({ ...view.current, scale }),
    [apply],
  );

  const zoomBy = useCallback(
    (factor: number) => zoomTo(view.current.scale * factor),
    [zoomTo],
  );

  /** Toggles between fit and 100% (or back to fit if already zoomed). */
  const toggleZoom = useCallback(
    (pointX = stageWidth / 2, pointY = stageHeight / 2) => {
      if (view.current.scale > fitScale * 1.001) reset();
      else zoomAt(Math.max(1, fitScale * 2.5), pointX, pointY);
    },
    [fitScale, reset, stageHeight, stageWidth, zoomAt],
  );

  /* -------------------------------------------------------- interactions */

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ distance: number; scale: number } | null>(null);
  const dragStart = useRef<{ x: number; y: number; fx: number; fy: number } | null>(null);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size === 1) {
      dragStart.current = {
        x: event.clientX,
        y: event.clientY,
        fx: view.current.fx,
        fy: view.current.fy,
      };
    } else if (pointers.current.size === 2) {
      dragStart.current = null;
      pinchStart.current = {
        distance: pointerDistance(pointers.current),
        scale: view.current.scale,
      };
    }
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.current.size >= 2 && pinchStart.current) {
        const distance = pointerDistance(pointers.current);
        if (pinchStart.current.distance > 0) {
          const centre = pointerCentre(pointers.current);
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          zoomAt(
            pinchStart.current.scale * (distance / pinchStart.current.distance),
            centre.x - rect.left,
            centre.y - rect.top,
          );
        }
        return;
      }

      const start = dragStart.current;
      if (!start) return;
      // Dragging right moves the photo right, i.e. the focal point left.
      apply(
        {
          scale: view.current.scale,
          fx: start.fx - (event.clientX - start.x) / view.current.scale,
          fy: start.fy - (event.clientY - start.y) / view.current.scale,
        },
        true,
      );
    },
    [apply, zoomAt],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      pointers.current.delete(event.pointerId);
      if (pointers.current.size < 2) pinchStart.current = null;
      if (pointers.current.size === 0) {
        dragStart.current = null;
        apply(view.current, false);
      }
    },
    [apply],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      // Trackpad pinch arrives as a ctrl-modified wheel; both map to zoom here.
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0022));
      zoomAt(view.current.scale * factor, event.clientX - rect.left, event.clientY - rect.top);
    },
    [zoomAt],
  );

  return {
    state,
    reset,
    zoomBy,
    zoomTo,
    toggleZoom,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onWheel },
  };
}

/** Turns the focal-point view into the translation the DOM needs. */
function project(
  view: View,
  fitScale: number,
  stageWidth: number,
  stageHeight: number,
  panning: boolean,
): ZoomPanState {
  return {
    scale: view.scale,
    x: stageWidth / 2 - view.fx * view.scale,
    y: stageHeight / 2 - view.fy * view.scale,
    fitScale,
    panning,
    zoomed: view.scale > fitScale * 1.001,
  };
}

function pointerDistance(pointers: Map<number, { x: number; y: number }>): number {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointerCentre(pointers: Map<number, { x: number; y: number }>): { x: number; y: number } {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return { x: 0, y: 0 };
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
