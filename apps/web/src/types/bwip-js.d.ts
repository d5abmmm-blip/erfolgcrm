/**
 * Минимальная декларация для bwip-js — пакет имеет conditional exports,
 * которые TypeScript bundler-resolution иногда не подхватывает корректно.
 * Покрываем только те части API, которые мы используем (toCanvas).
 */
declare module 'bwip-js' {
  export interface ToCanvasOptions {
    bcid: string;
    text: string;
    scale?: number;
    height?: number;
    width?: number;
    includetext?: boolean;
    textxalign?: 'offleft' | 'left' | 'center' | 'right' | 'offright' | 'justify';
    textsize?: number;
    paddingwidth?: number;
    paddingheight?: number;
    [key: string]: unknown;
  }

  export function toCanvas(canvas: HTMLCanvasElement, options: ToCanvasOptions): HTMLCanvasElement;

  const bwipjs: {
    toCanvas: typeof toCanvas;
  };
  export default bwipjs;
}
