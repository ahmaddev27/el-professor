/**
 * What one panel shows in place of a figure when a module it computes from is
 * switched off for this company.
 *
 * **It is not `ModuleOffPage` and not a hidden element.** `ModuleOffPage` is the
 * whole-route refusal of slice 2 — it owns the screen, offers a way back and a
 * mailto, and says the module is not activated. This is the *inside* of a page
 * that is still the customer's home screen: the Overview can never be off, so
 * the panel beside this one is probably still showing real figures, and a
 * second full-page refusal would be wrong twice over.
 *
 * Hiding the panel was the other candidate and is worse: the customer cannot
 * tell a figure that was **withheld** from one that was never there, and a
 * missing card on a dashboard reads as a product that lost a feature. The rule
 * this follows is the one phase 5 batch 2 wrote down for a failed load — *a
 * figure whose source is unavailable is not shown and the reason is stated.*
 *
 * Tokens and primitives only, no inline style and no hard-coded colour: the file
 * has no entry in `style-baseline.json` and the ratchet reads a missing entry as
 * zero. That matters more here than usual, because the file it renders inside —
 * `OverviewPage.tsx` — is a legacy screen with 187 inline styles, and a notice
 * built the way its neighbours are built would have raised that number.
 *
 * `caution`, not `critical`: nothing failed. An operator made a decision and
 * this is the product reporting it. `critical` is reserved for the load that
 * broke, which the Overview already renders above the first panel.
 */
import React from 'react';
import { PowerOff } from 'lucide-react';
import { Alert } from './ui';
import { useTranslation } from '../contexts/LanguageContext';
import { moduleDefinition } from '../lib/companyModules';
import type { TranslationKey } from '../i18n';

export interface ModuleOffNoticeProps {
  /**
   * The module keys this panel needed and did not get, in the order the panel's
   * dependency list declares them. Never empty — the caller renders the panel's
   * figures when it is.
   */
  moduleKeys: readonly string[];
  /** What the panel would have shown, for the sentence to name. Optional. */
  figureLabel?: string;
}

/**
 * The module's name as the sidebar spells it, so the operator's panel row, the
 * nav entry, the route refusal and this notice all use the same word.
 *
 * A key this build does not know falls back to the key itself rather than being
 * dropped: the registry is the newer half of the pair in a rolled-back release,
 * and a notice that silently named one module of two would understate the
 * reason. It cannot normally be reached — `moduleEnabled` reads an unknown key
 * as **on**, so an unknown module never gets this far — which is why the
 * fallback is a plain string and not a new dictionary entry.
 */
const moduleName = (t: (key: TranslationKey) => string, key: string): string => {
  const definition = moduleDefinition(key);
  return definition ? t(definition.labelKey) : key;
};

const ModuleOffNotice: React.FC<ModuleOffNoticeProps> = ({ moduleKeys, figureLabel }) => {
  const { t } = useTranslation();
  const names = moduleKeys.map(key => moduleName(t, key));

  return (
    <Alert
      tone="caution"
      icon={PowerOff}
      role="note"
      title={figureLabel ?? t('overview.moduleOff.title')}
    >
      {/*
        One sentence for one module and a list for several, rather than one
        sentence with a joined list in it: German puts the verb last and
        "Fixkosten und Gehälter ist nicht aktiviert" is wrong agreement. The
        plural key carries its own verb.
      */}
      {names.length === 1
        ? t('overview.moduleOff.one', { module: names[0] })
        : t('overview.moduleOff.many', { modules: names.join(', ') })}
      {' '}
      {t('overview.moduleOff.kept')}
    </Alert>
  );
};

export default ModuleOffNotice;
