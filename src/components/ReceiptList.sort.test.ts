import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Driver, Receipt } from '../types/receipt';
import { flatText, press } from '../test-utils/tree';

/**
 * The Belege list, rendered through the real German dictionary, for the five
 * column headers the owner asked to be sortable on 27.10.2026 — the printed
 * time, the litres, the price per litre, the odometer and the range left.
 *
 * **What this file exists for, and `receiptSort.test.ts` cannot say:** the two
 * figures in this screen's header, *Ausgaben gesamt* and *MwSt. 19 % gesamt*,
 * are reduced over the sorted list, and `reduce` over doubles is order
 * sensitive (measured, and recorded in the last test of that file). So the
 * claim that matters here is not about the comparator — it is that **the two
 * printed figures are the same two strings whichever of the five columns the
 * table is ordered by, in either direction.** This screen's rows go to a
 * Steuerberater; a sort that moved a total by a cent would be the worst outcome
 * this change could have.
 *
 * It also proves the control is wired at all: the five headers are buttons, and
 * pressing one reorders the rows the way the comparator says.
 *
 * Every name and figure here is invented.
 */

vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));

vi.mock('../contexts/LanguageContext', async () => {
  const { translate, translatePlural } = await import('../i18n');
  const value = {
    language: 'de',
    setLanguage: () => {},
    t: (key: never, vars?: never) => translate('de', key, vars),
    tPlural: (keys: never, count: number, vars?: never) => translatePlural('de', keys, count, vars),
  };
  return { useTranslation: () => value };
});

const { default: ReceiptList } = await import('./ReceiptList');
const { formatEuro } = await import('./ui/format');

/**
 * The two figures the header prints, taken from the formatter the screen itself
 * uses rather than written out here.
 *
 * What is pinned is the arithmetic — 245,21 € and 39,15 € — and not the
 * spelling, which is `formatEuroCents`' business and includes a NON-BREAKING
 * space before the sign. A literal one in this file would be invisible to the
 * next person to edit it: replaced by an ordinary space, every assertion below
 * would quietly stop matching anything while still reading as if it asserted.
 */
/** 18,47 + 72,30 + 12,00 + 103,55 + 0,01 + 5,55 + 33,33 */
const TOTAL_EXPENSES = formatEuro(245.21);
/** The 19 % inside those gross amounts. */
const TOTAL_VAT19 = formatEuro(39.15);

/**
 * The list opens on the current business month, so the fixture has to sit
 * inside it or every row is filtered away and the totals are 0,00 €. The 10th
 * to the 16th is inside the business month of any month, whichever weekday the
 * 1st falls on.
 */
const now = new Date();
const dayInThisMonth = (day: number): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const beleg = (over: Partial<Receipt> & { receiptNumber: string; date: string }): Receipt => ({
  id: over.receiptNumber,
  description: 'Tanken',
  driverName: 'Fahrer Beispiel',
  expense: 0,
  ...over,
});

/**
 * Out of order on all five columns, with two rows that carry no fuel figure at
 * all, one 0 km range (a reading, not an absence) and amounts whose float sum
 * differs between orderings.
 */
const RECEIPTS: Receipt[] = [
  beleg({ receiptNumber: 'BEL-0001', date: dayInThisMonth(12), expense: 18.47, receiptTime: '21:05:00', litres: 9.5, pricePerLitre: 1.789, odometerKm: 80284, rangeKm: 410 }),
  beleg({ receiptNumber: 'BEL-0002', date: dayInThisMonth(10), expense: 72.30, receiptTime: '05:26:00', litres: 10.2, pricePerLitre: 1.659, odometerKm: 172884, rangeKm: 95 }),
  beleg({ receiptNumber: 'BEL-0003', date: dayInThisMonth(16), expense: 12.00, description: 'Autowäsche' }),
  beleg({ receiptNumber: 'BEL-0004', date: dayInThisMonth(11), expense: 103.55, receiptTime: '00:04:00', litres: 1250.75, pricePerLitre: 2.009, odometerKm: 9999, rangeKm: 1105 }),
  beleg({ receiptNumber: 'BEL-0005', date: dayInThisMonth(15), expense: 0.01, receiptTime: '23:59:59', litres: 55.1, pricePerLitre: 1.009, odometerKm: 100, rangeKm: 0 }),
  beleg({ receiptNumber: 'BEL-0006', date: dayInThisMonth(13), expense: 5.55, receiptTime: '05:26:30', description: 'Parkgebühr' }),
  beleg({ receiptNumber: 'BEL-0007', date: dayInThisMonth(14), expense: 33.33, receiptTime: '12:00', litres: 9.5, pricePerLitre: 1.789, odometerKm: 80284, rangeKm: 410 }),
];

const DRIVERS: Driver[] = [{ id: 'driver-1', name: 'Fahrer Beispiel' }];

/** The five labels, exactly as both dictionaries already spelled them. */
const HEADERS = {
  receiptTime:   'Zeit',
  litres:        'Liter',
  pricePerLitre: 'Preis je Liter (€/l)',
  odometerKm:    'Kilometerstand',
  rangeKm:       'Restreichweite',
} as const;

function render(): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(createElement(ReceiptList, {
      receipts: RECEIPTS,
      drivers: DRIVERS,
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onExportExcel: vi.fn(),
      onDownloadPdf: vi.fn(),
      // No write rights, so no row action is drawn — this file is about the
      // header and the figures, and nothing here may write.
      canEdit: () => false,
      canDelete: () => false,
    }));
  });
  return tree!;
}

/**
 * The header button whose own text begins with `label`. Begins with, rather than
 * equals, because an active header appends its screen-reader direction.
 */
function header(tree: ReactTestRenderer, label: string): ReactTestInstance {
  const found = tree.root.findAll(node => node.type === 'button' && flatText(node).startsWith(label));
  // Exactly one: two would mean a label collides with another header's.
  expect(found, `header "${label}"`).toHaveLength(1);
  return found[0];
}

/** Every string the tree prints, flattened, in render order. */
function text(tree: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(tree.toJSON());
  return out.join('\u0001');
}

/** The Belegnummern in the order the table draws them. */
const rowOrder = (tree: ReactTestRenderer): string[] => text(tree).match(/BEL-\d+/g) ?? [];

/**
 * Every euro figure the screen prints, in render order: the per-row amounts and
 * VAT, the two header figures and the table's own totals row.
 *
 * Compared as a SET-with-counts rather than as a sequence, because sorting is
 * meant to move the per-row figures around. If either total changed, a string
 * would appear or disappear and the comparison fails.
 */
function euroFigures(tree: ReactTestRenderer): string[] {
  return (text(tree).match(/-?\d[\d.]*,\d{2}\u00a0€/g) ?? []).slice().sort();
}

describe('the five measured columns offer the sort control', () => {
  it('draws each of the five headers as a button', () => {
    const tree = render();
    for (const label of Object.values(HEADERS)) {
      expect(header(tree, label).props.type).toBe('button');
    }
    tree.unmount();
  });

  /**
   * Pressing a header once sorts ascending, and pressing it again flips the
   * direction — `handleSort`'s contract, unchanged.
   */
  it('ranks the odometer by its number, and flips on a second press', async () => {
    const tree = render();
    await press(header(tree, HEADERS.odometerKm));
    expect(rowOrder(tree)).toEqual([
      'BEL-0005', // 100
      'BEL-0004', // 9.999
      'BEL-0001', 'BEL-0007', // 80.284, tied, in the order they arrived
      'BEL-0002', // 172.884 — last, although "172.884" < "80.284" as text
      'BEL-0003', 'BEL-0006', // no reading
    ]);
    await press(header(tree, HEADERS.odometerKm));
    expect(rowOrder(tree)).toEqual([
      'BEL-0002', 'BEL-0001', 'BEL-0007', 'BEL-0004', 'BEL-0005',
      'BEL-0003', 'BEL-0006', // still last, on the descending sort too
    ]);
    tree.unmount();
  });

  it('ranks the litres by their number, so 9,50 comes before 10,20', async () => {
    const tree = render();
    await press(header(tree, HEADERS.litres));
    expect(rowOrder(tree)).toEqual([
      'BEL-0001', 'BEL-0007', 'BEL-0002', 'BEL-0005', 'BEL-0004', 'BEL-0003', 'BEL-0006',
    ]);
    tree.unmount();
  });

  /**
   * Both directions, and the descending half is the one that carries the
   * assertion — which a mutation control is what showed. BEL-0002 (05:26:00)
   * and BEL-0006 (05:26:30) both print `05:26`, and they arrive in that order,
   * so a sort that dropped the seconds would tie them and the stable sort would
   * still hand back BEL-0002 first: the ascending list alone cannot tell the
   * two implementations apart. Descending, a tie keeps BEL-0002 first and the
   * clock puts BEL-0006 there.
   */
  it('ranks the printed time by the clock, including the seconds the cell hides', async () => {
    const tree = render();
    await press(header(tree, HEADERS.receiptTime));
    expect(rowOrder(tree)).toEqual([
      'BEL-0004', 'BEL-0002', 'BEL-0006', 'BEL-0007', 'BEL-0001', 'BEL-0005',
      'BEL-0003', // no time
    ]);
    await press(header(tree, HEADERS.receiptTime));
    expect(rowOrder(tree)).toEqual([
      'BEL-0005', 'BEL-0001', 'BEL-0007',
      'BEL-0006', 'BEL-0002', // 05:26:30 ahead of 05:26:00, which only the seconds say
      'BEL-0004',
      'BEL-0003', // still last, on the descending sort too
    ]);
    tree.unmount();
  });
});

describe('the two totals are unchanged by sorting', () => {
  /**
   * THE ASSERTION THIS FILE IS FOR.
   *
   * The unsorted screen's figures are the reference, and every one of the ten
   * states reachable from the five new headers must print the same ones.
   */
  it('prints the same expense total and the same VAT total for all five columns, both directions', async () => {
    const tree = render();

    const expectedFigures = euroFigures(tree);
    const expectedRows = rowOrder(tree).length;
    // The reference is a real screen, not an empty one: the figures must be
    // there for their being unchanged to mean anything.
    expect(expectedRows).toBe(RECEIPTS.length);
    expect(text(tree)).toContain(TOTAL_EXPENSES);
    expect(text(tree)).toContain(TOTAL_VAT19);
    // Twice each: the KPI card and the table's own totals row.
    expect(expectedFigures.filter(figure => figure === TOTAL_EXPENSES)).toHaveLength(2);
    expect(expectedFigures.filter(figure => figure === TOTAL_VAT19)).toHaveLength(2);

    for (const label of Object.values(HEADERS)) {
      for (const pressNumber of [1, 2]) {
        await press(header(tree, label));
        const where = `${label}, press ${pressNumber}`;
        expect(rowOrder(tree).length, where).toBe(expectedRows);
        expect(euroFigures(tree), where).toEqual(expectedFigures);
        expect(text(tree), where).toContain(TOTAL_EXPENSES);
        expect(text(tree), where).toContain(TOTAL_VAT19);
      }
    }

    tree.unmount();
  });
});
