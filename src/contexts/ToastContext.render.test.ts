import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement, useEffect } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './ToastContext';

vi.mock('./LanguageContext', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOAST_LEVEL = 80;

function Raise() {
  const { error } = useToast();
  useEffect(() => { error('Bitte den Haendler eintragen.'); }, [error]);
  return null;
}

async function mount(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(ToastProvider, null, createElement(Raise))); });
  return tree;
}

const toastOf = (tree: ReactTestRenderer): ReactTestInstance =>
  tree.root.findAll(n => n.type === 'div' && n.props.role === 'alert')[0];

const containerOf = (tree: ReactTestRenderer): ReactTestInstance =>
  tree.root.findAll(n => n.type === 'div' && String(n.props.className).split(' ').includes('fixed'))[0];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/**
 * A message raised while a form is open has to be seen. It was not: the toast sat
 * on z-50 at the top right, under the Sheet, which opens on the right on the same
 * level from a later portal. Measured in a browser on 02.11.2026: the toast covered
 * by the sheet at every width, so Save appeared to do nothing.
 */
describe('where a toast appears', () => {
  it('is centred at the top, clear of the staging banner, on its own level', async () => {
    const tree = await mount();
    const classes = String(containerOf(tree).props.className);
    for (const expected of ['fixed', 'left-1/2', '-translate-x-1/2', `z-[${TOAST_LEVEL}]`, 'top-[calc(var(--env-banner-height,0px)+1rem)]']) {
      expect(classes, expected).toContain(expected);
    }
    expect(classes).not.toMatch(/right-\d/);
  });

  it('stacks above every dialog in the app', () => {
    const root = path.resolve(__dirname, '..');
    const offenders = sourceFiles(root).flatMap(file => {
      if (file.endsWith('ToastContext.tsx')) return [];
      return [...readFileSync(file, 'utf8').matchAll(/\bz-\[(\d+)\]/g)]
        .filter(m => Number(m[1]) >= TOAST_LEVEL)
        .map(m => `${path.relative(root, file)}: ${m[0]}`);
    });
    expect(offenders).toEqual([]);
  });

  it('can be pressed while a modal dialog is open, and the press never reaches the dialog', async () => {
    const tree = await mount();
    const toast = toastOf(tree);
    expect(String(toast.props.className)).toContain('pointer-events-auto');
    expect(String(containerOf(tree).props.className)).toContain('pointer-events-none');
    const stopPropagation = vi.fn();
    toast.props.onPointerDown({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('sits on a solid surface, so the page behind it does not show through', async () => {
    const tree = await mount();
    const toast = toastOf(tree);
    expect(String(toast.props.className)).toContain('bg-overlay');
    expect(toast.props.style.backgroundImage).toContain('linear-gradient');
    expect(toast.props.style.background).toBeUndefined();
  });
});
