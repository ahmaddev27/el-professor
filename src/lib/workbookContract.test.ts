/**
 * The browser's copy of the contract against the service's own.
 *
 * `deploy/export-service/export_service/contract.json` is what the service
 * validates against. The number formats and limits are held in both places, so
 * this fails the build when they part: a format the browser sends and the
 * service refuses would turn every export of a screen into a 422.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTRACT_LIMITS, CONTRACT_VERSION, NUMBER_FORMATS, isNumberFormat } from './workbookContract';

const service = JSON.parse(
  readFileSync(new URL('../../deploy/export-service/export_service/contract.json', import.meta.url), 'utf8'),
) as { version: number; creator: string; numberFormats: string[]; limits: Record<string, number> };

describe('workbookContract', () => {
  it('speaks the version the service reads', () => {
    expect(CONTRACT_VERSION).toBe(service.version);
  });

  it('lists exactly the number formats the service accepts, in the same order', () => {
    expect([...NUMBER_FORMATS]).toEqual(service.numberFormats);
  });

  it('holds the same limits', () => {
    expect({ ...CONTRACT_LIMITS }).toEqual(service.limits);
  });

  it('recognises a listed format and nothing else', () => {
    expect(isNumberFormat('#,##0.000')).toBe(true);
    expect(isNumberFormat('0;[Red]0')).toBe(false);
    expect(isNumberFormat(undefined)).toBe(false);
    expect(isNumberFormat(5)).toBe(false);
  });

  it('names openpyxl as the creator, the one fact the whole change is for', () => {
    expect(service.creator).toBe('openpyxl');
  });
});
