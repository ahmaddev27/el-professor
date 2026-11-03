import { describe, expect, it } from 'vitest';
import { de } from './de';
import { en } from './en';

/**
 * A sentence on a screen must not name a database column or a function. Fourteen
 * did (`assignment_block_id`, `company_id`, `generate_invoice_number`), in both
 * languages, and none of them told the person reading it what to do. What a row
 * says is `monthlyPlanMessages.ts`'s job, and an id is never a variable worth
 * printing.
 */
const SNAKE_CASE = /\b[a-z]{2,}(?:_[a-z0-9]+)+\b/;

const offenders = (dictionary: Record<string, string | undefined>): string[] =>
  Object.entries(dictionary)
    .filter(([, value]) => value !== undefined && SNAKE_CASE.test(value))
    .map(([key, value]) => `${key}: ${value}`);

describe('the dictionaries', () => {
  it('name no code in German', () => {
    expect(offenders(de)).toEqual([]);
  });

  it('name no code in English', () => {
    expect(offenders(en as Record<string, string | undefined>)).toEqual([]);
  });
});
