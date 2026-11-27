/** FNV-1a over a string's UTF-16 code units: stable across machines and runs. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The same hash as eight hex digits, as a run id carries it. */
export const fnv1a = (text: string): string => fnv1a32(text).toString(16).padStart(8, '0');
