/**
 * Turns an uploaded image file into a small JPEG `data:` URI thumbnail that fits comfortably in
 * the 32 KB metadata document (R1).
 *
 * @module lib/image
 */

/** Max accepted upload size before downscaling. */
export const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Downscales `file` to at most `maxPx` on the longer side and encodes it as JPEG. */
export async function imageFileToThumbnail(file: File, maxPx = 192, quality = 0.82): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) throw new Error('Images up to 8 MB, please.');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('Canvas is not available in this browser.');
    ctx.fillStyle = '#07090b';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    bitmap.close();
  }
}
