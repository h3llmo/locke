import sharp from "sharp";

/**
 * Small copies of an image for viewing in the browser: `thumb` for lists and grids, `display` for a full-screen view.
 * GPU jobs always work on the original and downloads always get it: previews are only ever shown.
 * WebP, oriented, without metadata, never larger than the original.
 */
export const PREVIEW_SIZES = ["thumb", "display"] as const;
export type PreviewSize = (typeof PREVIEW_SIZES)[number];
const SIDE: Record<PreviewSize, number> = { thumb: 480, display: 2048 };

sharp.concurrency(1);
sharp.cache(false);

let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

/** A preview, or null if the image can't be read or is already as small (the caller then sends the original). */
export function makePreview(image: Buffer, size: PreviewSize): Promise<Buffer | null> {
  return slot(async () => {
    try {
      return await sharp(image, { failOn: "error", limitInputPixels: 250_000_000 })
        .rotate()
        .resize({ width: SIDE[size], height: SIDE[size], fit: "inside", withoutEnlargement: true })
        .webp({ quality: size === "thumb" ? 70 : 82, effort: 2 })
        .toBuffer()
        .then((out) => (out.length < image.length ? out : null));
    } catch {
      return null;
    }
  });
}
