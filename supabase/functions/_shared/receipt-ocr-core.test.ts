import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MEDIA_TYPES,
  MAX_IMAGE_BASE64,
  RECEIPT_CATEGORIES,
  extractionPrompt,
  parseExtraction,
  requestProblem,
} from './receipt-ocr-core';

/**
 * What the AI agent is allowed to be handed, and what of its answer is believed.
 *
 * This endpoint spends money per call and writes nothing, so the tests that
 * matter are about what it refuses and what it drops — not about a happy path
 * that an upstream model decides anyway.
 */

describe('requestProblem', () => {
  const ok = { imageBase64: 'QUJD', mediaType: 'image/jpeg' };

  it('accepts a photograph of a type the agent can read', () => {
    expect(requestProblem(ok)).toBeNull();
    for (const mediaType of ALLOWED_MEDIA_TYPES) {
      expect(requestProblem({ ...ok, mediaType })).toBeNull();
    }
  });

  it('refuses a body that is not an object, or is missing either field', () => {
    for (const body of [null, undefined, 'x', 42, []]) {
      expect(requestProblem(body)).toBe('invalid_request');
    }
    expect(requestProblem({ mediaType: 'image/jpeg' })).toBe('invalid_request');
    expect(requestProblem({ imageBase64: 'QUJD' })).toBe('invalid_request');
    expect(requestProblem({ imageBase64: '', mediaType: 'image/jpeg' })).toBe('invalid_request');
  });

  it('refuses a type the image block does not take — a PDF above all', () => {
    // The salary-receipts bucket accepts application/pdf; this does not, because
    // what arrives here is a photograph taken in the driver's app.
    expect(requestProblem({ ...ok, mediaType: 'application/pdf' })).toBe('unsupported_media_type');
    expect(requestProblem({ ...ok, mediaType: 'text/html' })).toBe('unsupported_media_type');
    expect(requestProblem({ ...ok, mediaType: 'image/svg+xml' })).toBe('unsupported_media_type');
  });

  it('measures the cap after whitespace, because that is what is sent on', () => {
    const atCap = 'A'.repeat(MAX_IMAGE_BASE64);
    expect(requestProblem({ ...ok, imageBase64: atCap })).toBeNull();
    expect(requestProblem({ ...ok, imageBase64: atCap + 'A' })).toBe('image_too_large');
    // Whitespace cannot be used to slip past it, and does not trip it either.
    const padded = `${atCap.slice(0, 1000)}\n  \n${atCap.slice(1000)}`;
    expect(requestProblem({ ...ok, imageBase64: padded })).toBeNull();
  });

  it('reports the problem the caller can act on first', () => {
    // A bad type and an oversized image at once: naming the type is useless
    // advice when the body was never readable, and naming the size is useless
    // when the type will be refused anyway.
    const bad = { imageBase64: 'A'.repeat(MAX_IMAGE_BASE64 + 1), mediaType: 'application/pdf' };
    expect(requestProblem(bad)).toBe('unsupported_media_type');
  });
});

describe('parseExtraction', () => {
  it('reads a clean answer, and a fenced one', () => {
    const json = '{"date":"2026-10-04","amount":14.9,"category":"Autowäsche"}';
    const expected = { date: '2026-10-04', amount: 14.9, category: 'Autowäsche' };
    expect(parseExtraction(json)).toEqual(expected);
    expect(parseExtraction('```json\n' + json + '\n```')).toEqual(expected);
    expect(parseExtraction('```\n' + json + '\n```')).toEqual(expected);
  });

  it('answers null only when there is no JSON object at all', () => {
    expect(parseExtraction('I could not read this receipt.')).toBeNull();
    expect(parseExtraction('')).toBeNull();
    expect(parseExtraction('[1,2,3]')).toBeNull();
    expect(parseExtraction('null')).toBeNull();
    // An object with nothing usable is NOT null: the agent answered, it just
    // read nothing. The driver then sees empty fields, which is the truth.
    expect(parseExtraction('{}')).toEqual({});
  });

  it('drops a field it cannot trust rather than passing it through', () => {
    const out = parseExtraction(JSON.stringify({
      date: '04.10.2026',      // German order, not the ISO it was asked for
      time: '7:5',             // not HH:MM
      amount: -14.9,           // a receipt is not negative
      postalCode: '4265',      // four digits
      category: 'Tanken ',     // a trailing space is a different identifier
      confidence: 'sehr hoch', // not one of the three
    }));
    expect(out).toEqual({});
  });

  it('keeps the category byte-identical or not at all', () => {
    for (const category of RECEIPT_CATEGORIES) {
      expect(parseExtraction(JSON.stringify({ category }))?.category).toBe(category);
    }
    // `Tanken` selects the receipts that feed the Tankenquote. A re-spelling
    // would drop a receipt out of a statutory figure with nothing to show it.
    for (const near of ['tanken', 'TANKEN', 'Autowaesche', 'Öl Wechseln', 'Fuel']) {
      expect(parseExtraction(JSON.stringify({ category: near }))?.category).toBeUndefined();
    }
  });

  it('rounds the amount to the column\'s two decimals, once, here', () => {
    // Rounded in one place so the preview the driver confirms and the figure
    // that is stored cannot differ.
    expect(parseExtraction('{"amount":14.905}')?.amount).toBe(14.91);
    expect(parseExtraction('{"amount":14.904}')?.amount).toBe(14.9);
    expect(parseExtraction('{"amount":0}')?.amount).toBeUndefined();
    expect(parseExtraction('{"amount":"14,90"}')?.amount).toBeUndefined();
    expect(parseExtraction('{"amount":null}')?.amount).toBeUndefined();
  });

  it('bounds the free-text fields it does keep', () => {
    const long = 'x'.repeat(500);
    expect(parseExtraction(JSON.stringify({ merchantName: long }))?.merchantName).toHaveLength(120);
    expect(parseExtraction(JSON.stringify({ city: long }))?.city).toHaveLength(120);
    expect(parseExtraction(JSON.stringify({ receiptNumber: long }))?.receiptNumber).toHaveLength(64);
    expect(parseExtraction(JSON.stringify({ merchantName: '  Clean Car  ' }))?.merchantName)
      .toBe('Clean Car');
  });
});

describe('the prompt and the parser cannot drift', () => {
  it('offers exactly the categories the parser accepts', () => {
    const prompt = extractionPrompt();
    for (const category of RECEIPT_CATEGORIES) {
      expect(prompt, `prompt is missing ${category}`).toContain(`"${category}"`);
    }
  });

  it('still tells the agent to omit rather than guess', () => {
    // The whole design rests on it: a person confirms this reading, and an
    // empty field reads as "not read" where a guessed one reads as a fact.
    expect(extractionPrompt()).toMatch(/missing value is\s*\n?better than a guessed one/);
  });
});
