/**
 * The page a switched-off module renders, and the sentence it must not say.
 *
 * `LockedFeaturePage` — the page every gated route reached before this one
 * existed — says "{feature} is not included in your plan" and offers an
 * upgrade button. Reaching it for a *module* refusal would tell a Premium
 * customer to buy a plan they already hold, and send them to sales for a
 * problem one click in the platform panel fixes. The plan gate answers first
 * (App.moduleGate.test.ts pins the nesting), so by construction everyone who
 * sees this page has a plan that includes the feature.
 *
 * Rendered rather than read as source, because the claim is about what a user
 * is told: the module's own name has to appear, and the plan vocabulary has to
 * be absent from the whole output, including the button labels.
 */
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { textOf } from '../test-utils/tree';
// Statically imported, not `await import()`ed inside each test: the graph below
// it includes the whole `ui` barrel and the 7000-line German dictionary, and
// paying that inside the first test body exceeded vitest's 5 s timeout — the
// starvation class CLAUDE.md records for monthlyPlanDocumentBuilders.test.ts.
import ModuleOffPage from './ModuleOffPage';

const navigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

// The real dictionaries, so the German the customer reads is what is asserted —
// a stub `t` returning its key would pass whatever the wording said.
vi.mock('../contexts/LanguageContext', async () => {
  const { de } = await import('../i18n/de');
  return {
    useTranslation: () => ({
      t: (key: string, vars?: Record<string, unknown>) => {
        const text = (de as Record<string, string>)[key] ?? key;
        return vars
          ? text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`))
          : text;
      },
      tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
    }),
  };
});

// Synchronous: the component has no effect, no state and no query, so there is
// nothing for an async `act` to flush and an overlapping one only warns.
const render = (moduleName: string): ReactTestRenderer => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(createElement(ModuleOffPage, { moduleName }));
  });
  return tree;
};

describe('ModuleOffPage', () => {
  it('names the module the way the sidebar names it', () => {
    // `Fahrtenbuch` is the production case: `MODULE_DEFINITIONS` gives the
    // fahrtenbuch module `labelKey: 'doc.fahrtenbuch'`, which the nav renders
    // too, so the operator's panel row and the customer's refusal agree.
    const text = textOf(render('Fahrtenbuch'));
    expect(text).toContain('Fahrtenbuch');
    expect(text).toContain('nicht aktiviert');
    // The placeholder was substituted, not printed.
    expect(text).not.toContain('{module}');
  });

  it('says the plan is not the reason', () => {
    const text = textOf(render('Fahrtenbuch'));
    expect(text).toContain('nichts mit Ihrem Plan zu tun');
  });

  it('says the data is kept, which is a fact about the design', () => {
    /*
      Switching a module off writes one row in `company_modules` and nothing
      else: no delete, no archive, no cascade, and reads are not closed at all.
      So `on -> off -> on` is the identity. If a future change ever made that
      false, this sentence would become a lie and this assertion is where it
      should be noticed.
    */
    const text = textOf(render('Belege'));
    expect(text).toContain('unverändert erhalten');
  });

  it('never offers a plan upgrade', () => {
    const text = textOf(render('Fahrtenbuch'));
    for (const lie of ['Plan upgraden', 'nicht in Ihrem Plan', 'Verfügbar im', 'Basic', 'Advanced', 'Premium']) {
      expect(text, `ModuleOffPage must not say "${lie}"`).not.toContain(lie);
    }
  });

  it('offers a way out that is not a purchase', () => {
    const text = textOf(render('Fahrtenbuch'));
    expect(text).toContain('Zurück zur Übersicht');
    expect(text).toContain('Support kontaktieren');
  });
});
