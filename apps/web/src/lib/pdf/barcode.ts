/**
 * Code-128 barcode generation using bwip-js.
 * Returns a PNG data URL suitable for pdfmake `image:` field.
 */

// bwip-js exposes a browser entry that uses a canvas internally.
// We import the browser build to keep bundle size predictable.
import bwipjs from 'bwip-js';

export interface BarcodeOptions {
  /** bwip-js scale (px per module). Default 2 = ~150 DPI for ~3cm width. */
  scale?: number;
  /** total height in millimetres (bwip-js calls it height in mm). */
  heightMm?: number;
  /** include human-readable text under the bars? */
  includeText?: boolean;
}

/**
 * Generate a Code-128 barcode for `value` and return a PNG data URL.
 * Falls back to an empty data URL if bwip-js fails (so PDF generation
 * never breaks because of a barcode error).
 */
export function generateBarcodeDataUrl(
  value: string,
  options: BarcodeOptions = {},
): Promise<string> {
  const { scale = 2, heightMm = 12, includeText = true } = options;
  if (!value) return Promise.resolve('');

  try {
    const canvas = document.createElement('canvas');
    // bwip-js v4 browser API: toCanvas(canvas, opts) returns the canvas.
    // Some packagers expose the function on a default export, others on the
    // namespace itself, so we cover both shapes.
    const lib = bwipjs as unknown as {
      toCanvas?: (c: HTMLCanvasElement, o: Record<string, unknown>) => HTMLCanvasElement;
      default?: {
        toCanvas: (c: HTMLCanvasElement, o: Record<string, unknown>) => HTMLCanvasElement;
      };
    };
    const toCanvas = lib.toCanvas ?? lib.default?.toCanvas;
    if (!toCanvas) throw new Error('bwip-js: toCanvas is unavailable');

    toCanvas(canvas, {
      bcid: 'code128',
      text: value,
      scale,
      height: heightMm,
      includetext: includeText,
      textxalign: 'center',
      textsize: 8,
      paddingwidth: 4,
      paddingheight: 2,
    });

    return Promise.resolve(canvas.toDataURL('image/png'));
  } catch (err) {
    console.warn('[pdf/barcode] generation failed, falling back to empty image', err);
    return Promise.resolve('');
  }
}
