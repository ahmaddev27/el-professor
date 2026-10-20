import { createElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/** The generator's back link returns to where the user came from. */

vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('./SimulatedRidesPage', () => ({ default: () => null }));
vi.mock('./MonthlyPlanPage', () => ({ default: () => null }));
vi.mock('./ShiftRecommendationPage', () => ({ default: () => null }));
vi.mock('../components/shiftRecommendation/PlanningTypeChooser', () => ({
  PlanningTypeChooser: () => createElement('span', null, 'CHOOSER'),
}));
vi.mock('../contexts/LanguageContext', async () => {
  const { translate } = await import('../i18n');
  const value = { language: 'de', t: (key: never, vars?: never) => translate('de', key, vars) };
  return { useTranslation: () => value };
});

const { default: MonthlyPlanEntryPage } = await import('./MonthlyPlanEntryPage');

const labels: string[] = [];

function openAndGoBack(url: string) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(createElement(MemoryRouter, { initialEntries: [url] },
      createElement(Routes, null,
        createElement(Route, { path: '/monatsplan', element: createElement(MonthlyPlanEntryPage) }),
        createElement(Route, { path: '/fahrtenbuch', element: createElement('span', null, 'RIDE-LOG') }),
      )));
  });
  const back = tree.root.findAll(n => typeof n.type === 'string' && n.type === 'button')[0];
  labels.push(JSON.stringify(back.children));
  act(() => { back.props.onClick(); });
  return JSON.stringify(tree.toJSON());
}

describe('generator back link', () => {
  it('returns to the Fahrtenbuch when it was opened from there', () => {
    const out = openAndGoBack('/monatsplan?art=simuliert&from=fahrtenbuch');
    expect(out).toContain('RIDE-LOG');
    expect(labels.at(-1)).toContain('Zurück zum Fahrtenbuch');
  });
  it('returns to the Monatsplan chooser for the old address', () => {
    const out = openAndGoBack('/monatsplan?art=simuliert');
    expect(out).toContain('CHOOSER');
    expect(labels.at(-1)).toContain('Planungsart wechseln');
    expect(out).not.toContain('RIDE-LOG');
  });
});
