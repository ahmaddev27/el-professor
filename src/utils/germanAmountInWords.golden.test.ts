import { describe, expect, it } from 'vitest';
import {
  amountInWords,
  amountInWordsFromCents,
  deInt,
  MAX_AMOUNT_IN_WORDS_CENTS,
} from './germanAmountInWords';

/**
 * Golden master for the amount in words printed on the Trinkgeld-Quittung.
 *
 * Every expected string below was produced by running the original `deInt` and
 * `amountInWords` from TrinkgeldQuittungModal.tsx (origin/staging, lines 53–95),
 * transpiled as-is, before they were moved — not by reading the code and writing
 * down what it ought to say. So a failure here means the moved module prints
 * something the receipt did not print before.
 *
 * Characterization, not specification. "Einhundertein Euro", a minus sign that
 * disappears, and 2.675 € reading as 68 cent are what the receipt has always
 * printed; they are pinned so a change to them is a decision, not an accident.
 */
const EXPECTED_AMOUNTS: Array<[number, string]> = [
  [0, 'Null Euro und null Cent'],
  [0.01, 'Null Euro und ein Cent'],
  [0.09, 'Null Euro und neun Cent'],
  [0.1, 'Null Euro und zehn Cent'],
  [0.19, 'Null Euro und neunzehn Cent'],
  [0.2, 'Null Euro und zwanzig Cent'],
  [0.21, 'Null Euro und einundzwanzig Cent'],
  [0.99, 'Null Euro und neunundneunzig Cent'],
  [1, 'Ein Euro und null Cent'],
  [1.01, 'Ein Euro und ein Cent'],
  [1.1, 'Ein Euro und zehn Cent'],
  [2, 'Zwei Euro und null Cent'],
  [7, 'Sieben Euro und null Cent'],
  [11, 'Elf Euro und null Cent'],
  [12, 'Zwölf Euro und null Cent'],
  [16, 'Sechzehn Euro und null Cent'],
  [17, 'Siebzehn Euro und null Cent'],
  [19, 'Neunzehn Euro und null Cent'],
  [20, 'Zwanzig Euro und null Cent'],
  [21, 'Einundzwanzig Euro und null Cent'],
  [30, 'Dreißig Euro und null Cent'],
  [31, 'Einunddreißig Euro und null Cent'],
  [57, 'Siebenundfünfzig Euro und null Cent'],
  [60, 'Sechzig Euro und null Cent'],
  [66, 'Sechsundsechzig Euro und null Cent'],
  [70, 'Siebzig Euro und null Cent'],
  [77, 'Siebenundsiebzig Euro und null Cent'],
  [99, 'Neunundneunzig Euro und null Cent'],
  [100, 'Einhundert Euro und null Cent'],
  [101, 'Einhundertein Euro und null Cent'],
  [110, 'Einhundertzehn Euro und null Cent'],
  [111, 'Einhundertelf Euro und null Cent'],
  [116, 'Einhundertsechzehn Euro und null Cent'],
  [117, 'Einhundertsiebzehn Euro und null Cent'],
  [160, 'Einhundertsechzig Euro und null Cent'],
  [170, 'Einhundertsiebzig Euro und null Cent'],
  [199, 'Einhundertneunundneunzig Euro und null Cent'],
  [200, 'Zweihundert Euro und null Cent'],
  [216, 'Zweihundertsechzehn Euro und null Cent'],
  [999, 'Neunhundertneunundneunzig Euro und null Cent'],
  [1000, 'Eintausend Euro und null Cent'],
  [1001, 'Eintausendein Euro und null Cent'],
  [1016, 'Eintausendsechzehn Euro und null Cent'],
  [1100, 'Eintausendeinhundert Euro und null Cent'],
  [1111, 'Eintausendeinhundertelf Euro und null Cent'],
  [1234.56, 'Eintausendzweihundertvierunddreißig Euro und sechsundfünfzig Cent'],
  [2000, 'Zweitausend Euro und null Cent'],
  [10000, 'Zehntausend Euro und null Cent'],
  [16016.16, 'Sechzehntausendsechzehn Euro und sechzehn Cent'],
  [17017.17, 'Siebzehntausendsiebzehn Euro und siebzehn Cent'],
  [21000, 'Einundzwanzigtausend Euro und null Cent'],
  [99999.99, 'Neunundneunzigtausendneunhundertneunundneunzig Euro und neunundneunzig Cent'],
  [100000, 'Einhunderttausend Euro und null Cent'],
  [101101.01, 'Einhunderteintausendeinhundertein Euro und ein Cent'],
  [777777.77, 'Siebenhundertsiebenundsiebzigtausendsiebenhundertsiebenundsiebzig Euro und siebenundsiebzig Cent'],
  [999999.99, 'Neunhundertneunundneunzigtausendneunhundertneunundneunzig Euro und neunundneunzig Cent'],
  [198.34, 'Einhundertachtundneunzig Euro und vierunddreißig Cent'],
];

/** Float and input edge cases, same origin. */
const EXPECTED_EDGES: Array<[string, number, string]> = [
  ['1.005 rounds down (binary float below the half cent)', 1.005, 'Ein Euro und null Cent'],
  ['2.675 rounds up', 2.675, 'Zwei Euro und achtundsechzig Cent'],
  ['0.1 + 0.2 reads as thirty cent', 0.1 + 0.2, 'Null Euro und dreißig Cent'],
  ['a negative amount loses its sign', -12.5, 'Zwölf Euro und fünfzig Cent'],
  ['NaN reads as zero', Number.NaN, 'Null Euro und null Cent'],
  ['Infinity reads as zero', Number.POSITIVE_INFINITY, 'Null Euro und null Cent'],
];

const EXPECTED_INTS: Array<[number, string]> = [
  [0, 'null'],
  [1, 'ein'],
  [6, 'sechs'],
  [7, 'sieben'],
  [16, 'sechzehn'],
  [17, 'siebzehn'],
  [60, 'sechzig'],
  [70, 'siebzig'],
  [101, 'einhundertein'],
  [106, 'einhundertsechs'],
  [107, 'einhundertsieben'],
  [116, 'einhundertsechzehn'],
  [1000, 'eintausend'],
  [1001, 'eintausendein'],
  [7000, 'siebentausend'],
  [17000, 'siebzehntausend'],
  [60606, 'sechzigtausendsechshundertsechs'],
  [999999, 'neunhundertneunundneunzigtausendneunhundertneunundneunzig'],
];

describe('amountInWords — golden master from the original Trinkgeld-Quittung', () => {
  for (const [amount, words] of EXPECTED_AMOUNTS) {
    it(`${amount}`, () => {
      expect(amountInWords(amount)).toBe(words);
    });
  }

  for (const [label, amount, words] of EXPECTED_EDGES) {
    it(label, () => {
      expect(amountInWords(amount)).toBe(words);
    });
  }
});

describe('deInt — golden master', () => {
  for (const [n, words] of EXPECTED_INTS) {
    it(`${n}`, () => {
      expect(deInt(n)).toBe(words);
    });
  }

  it('refuses what it cannot spell', () => {
    for (const bad of [-1, 1.5, 1_000_000, Number.NaN]) {
      expect(() => deInt(bad)).toThrow(RangeError);
    }
  });
});

describe('amountInWordsFromCents', () => {
  it('agrees with the euro form on every golden amount', () => {
    for (const [amount, words] of EXPECTED_AMOUNTS) {
      expect(amountInWordsFromCents(Math.round(amount * 100))).toBe(words);
    }
  });

  it('spells the largest supported amount', () => {
    expect(amountInWordsFromCents(MAX_AMOUNT_IN_WORDS_CENTS)).toBe(
      'Neunhundertneunundneunzigtausendneunhundertneunundneunzig Euro und neunundneunzig Cent',
    );
  });

  it('refuses negative, fractional and out-of-range cents', () => {
    for (const bad of [-1, 0.5, MAX_AMOUNT_IN_WORDS_CENTS + 1, Number.NaN]) {
      expect(() => amountInWordsFromCents(bad)).toThrow(RangeError);
    }
  });
});

describe('above 999 999,99 € — the one deliberate change', () => {
  // The original printed "Zehnhunderttausend Euro und null Cent" for a million
  // and "Zwölfhundertvierunddreißigtausend…" for 1 234 567,89. Not German, and
  // it went onto the receipt. Refusing is the smaller harm.
  it('throws instead of printing words that are not German', () => {
    expect(() => amountInWords(1_000_000)).toThrow(RangeError);
    expect(() => amountInWords(1_234_567.89)).toThrow(RangeError);
  });
});
