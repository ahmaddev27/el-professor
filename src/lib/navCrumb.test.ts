import { describe, expect, it } from 'vitest';
import { navCrumbKey, type CrumbSource } from './navCrumb';

const ITEMS: CrumbSource[] = [
  { path: '/admin', labelKey: 'admin.nav.platform', end: true },
  { path: '/admin/companies', labelKey: 'admin.nav.companies' },
  { path: '/admin/konto', labelKey: 'admin.nav.account' },
  { path: '/belege', labelKey: 'nav.belege' },
];

describe('navCrumbKey', () => {
  it('names the section of an exact path', () => {
    expect(navCrumbKey('/admin', ITEMS)).toBe('admin.nav.platform');
    expect(navCrumbKey('/belege', ITEMS)).toBe('nav.belege');
  });

  it('names the section of a page under it, longest path first', () => {
    expect(navCrumbKey('/admin/companies/42', ITEMS)).toBe('admin.nav.companies');
  });

  it('keeps an `end` entry to its own path', () => {
    expect(navCrumbKey('/admin/unknown', ITEMS)).toBeNull();
  });

  it('does not match a path that only shares a prefix', () => {
    expect(navCrumbKey('/belegeX', ITEMS)).toBeNull();
    expect(navCrumbKey('/admin/kontoauszug', ITEMS)).toBeNull();
  });

  it('answers null for an address no destination covers', () => {
    expect(navCrumbKey('/abo-aktivieren', ITEMS)).toBeNull();
  });
});
