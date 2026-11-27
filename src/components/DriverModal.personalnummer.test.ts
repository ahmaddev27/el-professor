import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settle } from '../test-utils/tree';
import type { Driver } from '../types/receipt';

/**
 * The staff number field: a driver without one is offered the company's next
 * number, and the offer never replaces what the operator typed or an existing number.
 */

const world = vi.hoisted(() => ({
  answer: { data: '00023' as unknown, error: null as unknown },
  hold: null as null | Promise<void>,
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
  translation: {
    t: (key: string) => key,
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase(() => (
    world.hold
      ? (world.hold.then(() => world.answer) as unknown as typeof world.answer)
      : world.answer
  ));
  return { supabase: world.fake.client };
});
vi.mock('../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));
vi.mock('./ui', async importOriginal => {
  const original = await importOriginal<typeof import('./ui')>();
  const pass = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    ...original,
    Sheet: pass, SheetBody: pass, SheetContent: pass, SheetDescription: pass,
    SheetFooter: pass, SheetHeader: pass, SheetTitle: pass,
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: DriverModal } = await import('./DriverModal');

const FIELD = { placeholder: 'fleet.personalnummerPlaceholder' };

async function open(driver?: Driver): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(DriverModal, { isOpen: true, onClose: vi.fn(), onSave: vi.fn(), driver, title: 'T' }));
  });
  await settle();
  return tree;
}

const field = (tree: ReactTestRenderer) => tree.root.findByProps(FIELD);
const rpcCalls = () => (world.fake?.calls ?? []).filter(c => c.table === 'rpc:driver_next_personalnummer');
const texts = (tree: ReactTestRenderer) => JSON.stringify(tree.toJSON());

beforeEach(() => {
  world.answer = { data: '00023', error: null };
  world.hold = null;
  world.fake?.calls.splice(0);
});

describe('DriverModal staff number', () => {
  it('offers the next number for a new driver, with the suggestion hint', async () => {
    const tree = await open();
    expect(field(tree).props.value).toBe('00023');
    expect(texts(tree)).toContain('fleet.personalnummerSuggested');
  });

  it('offers it for an existing driver that has none', async () => {
    const tree = await open({ id: 'd1', name: 'Nora Vogt', salary_ratio: 0.5, personalnummer: '' } as unknown as Driver);
    expect(field(tree).props.value).toBe('00023');
  });

  it('does not ask, and does not change, an existing number', async () => {
    const tree = await open({ id: 'd1', name: 'Nora Vogt', salary_ratio: 0.5, personalnummer: '00007' } as unknown as Driver);
    expect(field(tree).props.value).toBe('00007');
    expect(rpcCalls()).toHaveLength(0);
  });

  it('never overwrites what was typed before the answer arrived', async () => {
    let release!: () => void;
    world.hold = new Promise<void>(resolve => { release = resolve; });
    const tree = await open();
    await act(async () => { field(tree).props.onChange({ target: { value: 'A-1' } }); });
    await act(async () => { release(); });
    await settle();
    expect(field(tree).props.value).toBe('A-1');
    expect(texts(tree)).not.toContain('fleet.personalnummerSuggested');
  });

  it.each([
    ['an error', { data: null, error: { message: 'boom' } }],
    ['null', { data: null, error: null }],
    ['an empty string', { data: '', error: null }],
  ])('leaves the field empty on %s', async (_label, answer) => {
    world.answer = answer;
    const tree = await open();
    expect(field(tree).props.value).toBe('');
    expect(field(tree).props.required).toBe(true);
  });
});
