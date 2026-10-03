/**
 * Who the Abrechnung can be mailed to — and the one case that must never be
 * resolved by guessing.
 *
 * The Abrechnung carries no driver id; its rows name a driver and nothing else.
 * So mailing means matching a name against the company's list, and the cost of
 * taking the first match when two drivers share a name is one driver's money
 * figures in another person's inbox.
 */
import { describe, it, expect } from 'vitest';
import { planRecipients, nameKey, nothingToSend, type RecipientDriver } from './driverRecipients';

const drivers: RecipientDriver[] = [
  { id: 'd1', name: 'Ahmed Hemaid', email: 'ahmed@example.com' },
  { id: 'd2', name: 'Alev Büyükay', email: 'alev@example.com' },
  { id: 'd3', name: 'Ferhat Erol', email: null },
  { id: 'd4', name: 'Mehmet Yılmaz', email: 'mehmet1@example.com' },
  { id: 'd5', name: 'Mehmet Yılmaz', email: 'mehmet2@example.com' },
  { id: 'd6', name: 'Leer Adresse', email: '   ' },
];

describe('planRecipients', () => {
  it('sends to a driver whose name resolves to exactly one address', () => {
    const plan = planRecipients(['Ahmed Hemaid', 'Alev Büyükay'], drivers);
    expect(plan.sendable.map(r => r.driverId)).toEqual(['d1', 'd2']);
    expect(plan.sendable[0].email).toBe('ahmed@example.com');
    expect(plan.noEmail).toEqual([]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.unknown).toEqual([]);
  });

  it('REFUSES a name two drivers share, rather than picking one', () => {
    // The assertion this file exists for. Taking the first match here sends one
    // person's figures to another person.
    const plan = planRecipients(['Mehmet Yılmaz'], drivers);
    expect(plan.sendable).toEqual([]);
    expect(plan.ambiguous).toEqual(['Mehmet Yılmaz']);
  });

  it('names a driver with no address rather than skipping them silently', () => {
    // The owner asked for this explicitly: "يذكرهم".
    const plan = planRecipients(['Ferhat Erol', 'Leer Adresse'], drivers);
    expect(plan.sendable).toEqual([]);
    // An address of only spaces is no address.
    expect(plan.noEmail).toEqual(['Ferhat Erol', 'Leer Adresse']);
  });

  it('names a driver the company list does not carry at all', () => {
    // An Abrechnung row can name a driver who has since been deleted.
    const plan = planRecipients(['Geloeschter Fahrer'], drivers);
    expect(plan.unknown).toEqual(['Geloeschter Fahrer']);
  });

  it('keeps the table order, so the confirmation reads down the screen', () => {
    const plan = planRecipients(['Alev Büyükay', 'Ahmed Hemaid'], drivers);
    expect(plan.sendable.map(r => r.rowName)).toEqual(['Alev Büyükay', 'Ahmed Hemaid']);
  });

  it('decides a repeated name once', () => {
    const plan = planRecipients(['Ahmed Hemaid', 'Ahmed Hemaid'], drivers);
    expect(plan.sendable).toHaveLength(1);
  });

  it('ignores an empty row name instead of reporting it as unknown', () => {
    const plan = planRecipients(['', '   ', 'Ahmed Hemaid'], drivers);
    expect(plan.unknown).toEqual([]);
    expect(plan.sendable).toHaveLength(1);
  });
});

describe('nameKey — what counts as the same person', () => {
  it('ignores case and inner spacing', () => {
    expect(nameKey('Ahmed  Hemaid')).toBe(nameKey('ahmed hemaid'));
    expect(nameKey('  AHMED HEMAID  ')).toBe(nameKey('Ahmed Hemaid'));
  });

  it('keeps accents and non-Latin letters, which are part of a name', () => {
    // Folding these would make two different people one, which is the same
    // defect as the ambiguous case and harder to see.
    expect(nameKey('Büyükay')).not.toBe(nameKey('Buyukay'));
    expect(nameKey('Yılmaz')).not.toBe(nameKey('Yilmaz'));
  });

  it('matches the German lower case, where I differs from the English one', () => {
    // Turkish names are common in this product's fleets, and `toLowerCase()`
    // without a locale is the English rule.
    expect(nameKey('MEHMET')).toBe('mehmet');
  });
});

describe('nothingToSend', () => {
  it('is true when every name was refused, however it was refused', () => {
    expect(nothingToSend(planRecipients(['Mehmet Yılmaz', 'Ferhat Erol'], drivers))).toBe(true);
    expect(nothingToSend(planRecipients(['Ahmed Hemaid'], drivers))).toBe(false);
  });
});
