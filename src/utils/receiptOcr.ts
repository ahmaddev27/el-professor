/**
 * Reading a receipt in the browser: prepare the image, run tesseract, hand the
 * text to the rules.
 *
 * The rules themselves are in `receiptTextParse.ts` and need no browser, so the
 * same ones run wherever text comes from. What is left here is the part that
 * cannot: a canvas to scale and raise the contrast, and the tesseract worker.
 */

import { createWorker } from 'tesseract.js';
import { parseReceiptText } from './receiptTextParse';

export type { OcrResult, OcrCandidate, PlzDebugCandidate } from './receiptTextParse';
export { formatAmountDE, __ocrInternals, parseReceiptText } from './receiptTextParse';

import type { OcrResult } from './receiptTextParse';

// ── Image preprocessing via Canvas ──────────────────────────────────────────

function preprocessImage(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const scale = Math.max(1, Math.min(3, 1600 / Math.max(img.width, img.height)));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        const d = imageData.data;
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          const c = Math.min(255, Math.max(0, (lum - 128) * 1.5 + 128));
          d[i] = d[i + 1] = d[i + 2] = c;
        }
        ctx.putImageData(imageData, 0, 0);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

// ── Main export ──────────────────────────────────────────────────

export async function extractReceiptData(
  file: File | Blob,
  onProgress?: (pct: number) => void,
): Promise<OcrResult> {
  const dataUrl = await preprocessImage(file);

  const worker = await createWorker('deu+eng', 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text' && onProgress) {
        onProgress(Math.round(m.progress * 100));
      }
    },
  });

  try {
    const { data: { text } } = await worker.recognize(dataUrl);
    return parseReceiptText(text);
  } finally {
    await worker.terminate();
  }
}

/**
 * The text lines found on a photo of a car's cluster. The image is read in the
 * browser and dropped; nothing is uploaded or stored. The rule that turns the
 * lines into an odometer is `odometerRead.ts`.
 */
export async function extractClusterLines(file: File | Blob): Promise<string[]> {
  const dataUrl = await preprocessImage(file);
  const worker = await createWorker('deu+eng');
  try {
    const { data: { text } } = await worker.recognize(dataUrl);
    return text.split(/\r?\n/);
  } finally {
    await worker.terminate();
  }
}
