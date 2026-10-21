import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertRowsUpdated } from './updateOutcome';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('assertRowsUpdated', () => {
  it('accepts a statement that changed a row', () => {
    expect(() => assertRowsUpdated([{ id: 'a' }], 'refused')).not.toThrow();
  });
  it.each([[[]], [null], [undefined]])('reports a refusal when no row came back (%j)', rows => {
    expect(() => assertRowsUpdated(rows, 'refused')).toThrow('refused');
  });
});

describe('deactivating a driver', () => {
  const hook = read('../hooks/useDatabase.ts');
  const updateDriver = hook.slice(hook.indexOf('const updateDriver = async'), hook.indexOf('// Receipt operations'));

  it('writes status through updateDriver and reads the rows back', () => {
    expect(updateDriver).toContain('updateData.status = status');
    expect(updateDriver).toMatch(/\.update\(updateData\)\s*\.eq\('id', id\)\s*\.select\('id'\)/);
    expect(updateDriver).toContain('assertRowsUpdated(');
  });

  it('has no delete path left: not in the hook, the page or the screen', () => {
    expect(hook).not.toMatch(/deleteDriver|\.from\('drivers'\)\s*\.delete\(/);
    const driversApi = hook.slice(hook.indexOf('drivers: {'), hook.indexOf('receipts: {'));
    expect(driversApi).toContain('update: updateDriver');
    expect(driversApi).not.toContain('delete');
    const page = read('../pages/FahrerPage.tsx');
    const screen = read('../components/DriversManagement.tsx');
    for (const src of [page, screen]) {
      expect(src).not.toMatch(/onDeleteDriver|handleDeleteDriver|canDelete|Trash2|driverActions\.delete/);
    }
  });
});
