// Stamps the Schema Breeze badge (logo and name) into the bottom-right corner of exported images.

const LABEL = 'Schema Breeze';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export interface BadgeLayout {
  x: number; y: number; width: number; height: number; margin: number;
  padX: number; icon: number; gap: number; fontSize: number; textX: number;
}

/** Badge geometry in image pixels. Height is 5% of the image's shorter side, kept between 48 and 72px. */
export function badgeLayout(imageW: number, imageH: number, textWidth: number): BadgeLayout {
  const height = Math.round(Math.min(72, Math.max(48, Math.min(imageW, imageH) * 0.05)));
  const margin = Math.round(height * 0.45);
  const padX = Math.round(height * 0.32);
  const icon = Math.round(height * 0.62);
  const gap = Math.round(height * 0.22);
  const width = padX + icon + gap + textWidth + padX;
  const x = imageW - margin - width;
  const y = imageH - margin - height;
  return { x, y, width, height, margin, padX, icon, gap, fontSize: Math.round(height * 0.42), textX: x + padX + icon + gap };
}

/**
 * Canvas size and badge position for a stamped export. Exports are cropped tight to the graph, so a
 * strip is added below the image for the badge rather than drawing it over nodes.
 */
export function stampedLayout(imageW: number, imageH: number, textWidth: number) {
  const sized = badgeLayout(imageW, imageH, textWidth);
  const badge = { ...sized, y: imageH + sized.margin };
  return { canvasW: imageW, canvasH: imageH + sized.height + 2 * sized.margin, badge };
}

/** The extension icon (public/icons/icon.svg, a 64-unit square), drawn at (x, y) with the given size. */
function drawIcon(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, size: number) {
  const k = size / 64;
  const p = (ux: number, uy: number): [number, number] => [x + ux * k, y + uy * k];
  ctx.save();
  ctx.strokeStyle = '#19a4a2';
  ctx.lineWidth = 4 * k;
  ctx.lineCap = 'round';
  for (const [a, b] of [[[20, 20], [44, 18]], [[20, 20], [24, 46]], [[44, 18], [46, 44]], [[24, 46], [46, 44]]] as const) {
    ctx.beginPath();
    ctx.moveTo(...p(a[0], a[1]));
    ctx.lineTo(...p(b[0], b[1]));
    ctx.stroke();
  }
  for (const [cx, cy, r, fill] of [[20, 20, 9, '#f08c3a'], [44, 18, 7, '#19a4a2'], [24, 46, 7, '#19a4a2'], [46, 44, 7, '#19a4a2']] as const) {
    ctx.beginPath();
    ctx.arc(...p(cx, cy), r * k, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.restore();
}

/** Returns a copy of the PNG with a strip in the export's background colour added below it, holding the badge. */
export async function stampBadge(png: Blob, dark: boolean, background: string): Promise<Blob> {
  const img = await createImageBitmap(png);
  const font = `600 ${badgeLayout(img.width, img.height, 0).fontSize}px ${FONT}`;
  const measure = new OffscreenCanvas(1, 1).getContext('2d')!;
  measure.font = font;
  const { canvasW, canvasH, badge: b } = stampedLayout(img.width, img.height, Math.ceil(measure.measureText(LABEL).width));

  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.drawImage(img, 0, 0);
  ctx.font = font;

  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.width, b.height, b.height / 2);
  ctx.fillStyle = dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 20, 30, 0.05)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, b.height / 40);
  ctx.strokeStyle = dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(15, 20, 30, 0.12)';
  ctx.stroke();

  drawIcon(ctx, b.x + b.padX, b.y + (b.height - b.icon) / 2, b.icon);
  ctx.fillStyle = dark ? 'rgba(255, 255, 255, 0.82)' : 'rgba(15, 20, 30, 0.75)';
  ctx.textBaseline = 'middle';
  ctx.fillText(LABEL, b.textX, b.y + b.height / 2);

  img.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

/** The last step of an image export: free plans get the badge, paid plans get the image as rendered. */
export async function finishExport(
  png: Blob,
  { dark, background, paid, stamp = stampBadge }: {
    dark: boolean; background: string; paid: boolean;
    stamp?: (png: Blob, dark: boolean, background: string) => Promise<Blob>;
  },
): Promise<Blob> {
  return paid ? png : stamp(png, dark, background);
}
