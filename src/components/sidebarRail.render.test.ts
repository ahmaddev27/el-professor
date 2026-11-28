import { createElement, type ReactElement } from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { DirectionProvider } from '@radix-ui/react-direction';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The collapsible rail in both live shells (owner, 27.11.2026): one stored
 * choice under one key, a rail only where the sidebar is a pane, every item
 * named while its label is hidden, the menu button named, and the 10 px
 * gutter between the sidebar and the sheet.
 */

vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../contexts/LanguageContext', async () => {
  const { translate } = await import('../i18n');
  const value = { language: 'de', t: (key: never, vars?: never) => translate('de', key, vars) };
  return { useTranslation: () => value };
});
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ signOut: async () => undefined, isSuperAdmin: false, profile: { email: 'owner@example.com' } }),
}));
vi.mock('../contexts/SuperAdminContext', () => ({
  useSuperAdmin: () => ({
    isViewingAsCompany: false, activeCompany: null, exitCompany: () => undefined,
    platformAccess: { role: 'owner' }, platformCan: () => true,
  }),
}));
vi.mock('../contexts/CompanySettingsContext', () => ({ useCompanySettings: () => ({ settings: { company_name: 'Testfirma' } }) }));
vi.mock('../contexts/PlanContext', () => ({ usePlan: () => ({ can: () => true, companyModules: {} }) }));

const { default: Sidebar } = await import('./Sidebar');
const { default: AdminSidebar } = await import('./AdminSidebar');
const rail = await import('./ui/sidebarRail');

let stored: Record<string, string>;
let desktop: boolean;

beforeEach(() => {
  stored = {};
  desktop = true;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key in stored ? stored[key] : null),
    setItem: (key: string, value: string) => { stored[key] = value; },
  });
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({
      matches: query === rail.SHELL_DESKTOP_QUERY && desktop,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    setTimeout, clearTimeout,
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function render(element: ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(createElement(MemoryRouter, null, element)); });
  return tree;
}

const byType = (tree: ReactTestRenderer, type: string) =>
  tree.root.findAll(node => node.type === type);
const aside = (tree: ReactTestRenderer) => byType(tree, 'aside')[0];
const toggle = (tree: ReactTestRenderer) =>
  byType(tree, 'button').find(node => node.props['aria-controls'] === rail.SHELL_SIDEBAR_ID && !String(node.props.className).includes('fixed'))!;
const menuButton = (tree: ReactTestRenderer) =>
  byType(tree, 'button').find(node => String(node.props.className).includes('fixed start-4'))!;
const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOf(child))).join('');

const SHELLS = [
  { name: 'company sidebar', element: () => createElement(Sidebar, { isSupportAdmin: true }) },
  { name: 'panel sidebar', element: () => createElement(AdminSidebar) },
];

describe('the shared collapse choice', () => {
  it('is stored under exactly one key, in exactly one file', () => {
    const SRC = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.test\./.test(entry)) files.push(path);
      }
    };
    walk(SRC);
    const holders = files.filter(path => readFileSync(path, 'utf8').includes("'ya-shell-collapsed'"));
    expect(holders.map(path => path.slice(SRC.length + 1))).toEqual(['components/ui/sidebarRail.tsx']);
  });

  it('reads "1" as collapsed and writes "1" / "0"', () => {
    expect(rail.readSidebarCollapsed()).toBe(false);
    rail.writeSidebarCollapsed(true);
    expect(stored['ya-shell-collapsed']).toBe('1');
    expect(rail.readSidebarCollapsed()).toBe(true);
    rail.writeSidebarCollapsed(false);
    expect(stored['ya-shell-collapsed']).toBe('0');
  });
});

describe.each(SHELLS)('the $name', ({ element }) => {
  it('is a 254 px pane with labels when expanded, and names its toggle "einklappen"', () => {
    const tree = render(element());
    expect(aside(tree).props.id).toBe(rail.SHELL_SIDEBAR_ID);
    expect(aside(tree).props.className).toContain('lg:w-[254px]');
    expect(toggle(tree).props['aria-expanded']).toBe(true);
    expect(toggle(tree).props['aria-label']).toBe('Seitenleiste einklappen');
    for (const link of byType(tree, 'a')) expect(link.props['aria-label']).toBeUndefined();
  });

  it('collapses to a 68 px rail that keeps every item named, and remembers it', () => {
    const tree = render(element());
    act(() => { toggle(tree).props.onClick(); });
    expect(stored['ya-shell-collapsed']).toBe('1');
    expect(aside(tree).props.className).toContain('lg:w-[68px]');
    expect(toggle(tree).props['aria-expanded']).toBe(false);
    expect(toggle(tree).props['aria-label']).toBe('Seitenleiste ausklappen');
    const named = [...byType(tree, 'a'), ...byType(tree, 'button')].filter(node => node !== menuButton(tree));
    expect(named.length).toBeGreaterThan(5);
    for (const node of named) {
      const label = node.props['aria-label'];
      expect(typeof label === 'string' && label.length > 0, textOf(node)).toBe(true);
    }
    // Every label text the rail hides is the aria-label beside it.
    for (const span of byType(tree, 'span').filter(node => node.props.className === 'hidden')) {
      expect(span.parent?.props['aria-label']).toBe(textOf(span));
    }
  });

  it.each(['0', '1'])('draws every link with real classes (stored "%s")', value => {
    stored['ya-shell-collapsed'] = value;
    // The navigation links; the legal links open a new tab and draw their own way.
    const links = byType(render(element()), 'a').filter(node => String(node.props.href).startsWith('/') && !node.props.target);
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) {
      expect(typeof link.props.className).toBe('string');
      expect(link.props.className).toContain('h-9');
      expect(link.props.className).not.toMatch(/=>|isActive/);
    }
  });

  it('hides labels only in the rail', () => {
    stored['ya-shell-collapsed'] = '1';
    const hidden = byType(render(element()), 'span').filter(node => node.props.className === 'hidden');
    expect(hidden.length).toBeGreaterThan(3);
    stored['ya-shell-collapsed'] = '0';
    const open = render(element());
    expect(byType(open, 'span').filter(node => String(node.props.className).includes('hidden'))).toHaveLength(0);
  });

  it('opens collapsed from the stored choice on a wide screen', () => {
    stored['ya-shell-collapsed'] = '1';
    expect(aside(render(element())).props.className).toContain('lg:w-[68px]');
  });

  it('stays a labelled drawer below lg, whatever was stored', () => {
    stored['ya-shell-collapsed'] = '1';
    desktop = false;
    const tree = render(element());
    expect(aside(tree).props.className).toContain('lg:w-[254px]');
    expect(byType(tree, 'span').filter(node => node.props.className === 'hidden')).toHaveLength(0);
  });

  it('names its menu button and says whether the drawer is open', () => {
    const tree = render(element());
    expect(menuButton(tree).props['aria-label']).toBe('Navigation öffnen');
    expect(menuButton(tree).props['aria-expanded']).toBe(false);
    act(() => { menuButton(tree).props.onClick(); });
    expect(menuButton(tree).props['aria-label']).toBe('Navigation schließen');
    expect(menuButton(tree).props['aria-expanded']).toBe(true);
  });

  it('keeps 10 px all round the pane, so 10 px to the sheet beside it', () => {
    const classes = String(aside(render(element())).props.className).split(/\s+/);
    expect(classes).toContain('lg:m-[10px]');
    expect(classes.filter(name => /^lg:m[stebxy]?-/.test(name))).toEqual(['lg:m-[10px]']);
  });
});

describe('the company sidebar in the rail', () => {
  it('turns a group name into a hairline that a screen reader still reads', () => {
    stored['ya-shell-collapsed'] = '1';
    const tree = render(createElement(Sidebar, { isSupportAdmin: true }));
    const names = byType(tree, 'p').filter(node => node.props.className === 'sr-only').map(textOf);
    expect(names).toContain('Verwaltung');
  });
});

describe('the layouts around them', () => {
  it.each(['AppLayout.tsx', 'AdminLayout.tsx'])('%s pads the sheet column on three sides only', file => {
    const source = readFileSync(join(__dirname, file), 'utf8');
    const column = source.match(/<div className="(min-w-0 flex-1[^"]*)">/)?.[1] ?? '';
    expect(column).toContain('lg:py-[10px] lg:pe-[10px]');
    expect(column).not.toMatch(/lg:p[sx]-/);
  });
});

describe('the rail tooltip', () => {
  const Side = () => createElement('i', { 'data-side': rail.useRailTipSide() });
  it.each([['ltr', 'right'], ['rtl', 'left']] as const)('opens away from the sidebar in %s', (dir, side) => {
    let tree!: ReactTestRenderer;
    act(() => { tree = create(createElement(DirectionProvider, { dir }, createElement(Side))); });
    expect(tree.root.findByType('i').props['data-side']).toBe(side);
  });
});
