/**
 * The page a route shows when its module is switched off for this company.
 *
 * **It is deliberately not `LockedFeaturePage`.** That screen says "{feature}
 * is not included in your plan" and offers an upgrade; a Premium customer whose
 * operator switched a module off would be told to buy a plan they already have.
 * The two refusals have different causes, different remedies and therefore
 * different pages — Docs/design/per-company-modules.md section 7, message
 * precedence: the plan is the outer boundary and answers first, so anyone who
 * reaches this page has a plan that *does* include the feature.
 *
 * Two things the copy must keep saying:
 *
 *   - **"nothing to do with your plan"**, so nobody is sent to buy an upgrade
 *     that would change nothing; and
 *   - **"your existing data is kept unchanged"**, which is a true statement
 *     about this design rather than reassurance. Switching a module off writes
 *     one row in `company_modules` and nothing else — no delete, no archive, no
 *     cascade — so `on → off → on` is the identity (section 5's prohibition).
 *     Reads are not closed either, so the customer's own figures are still
 *     readable by every screen that was reading them.
 *
 * Tokens and primitives only, no inline style and no hard-coded colour: the
 * file has no entry in `style-baseline.json` and the ratchet reads a missing
 * entry as zero.
 */
import React from 'react';
import { PowerOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, EmptyState } from './ui';
import { useTranslation } from '../contexts/LanguageContext';

export interface ModuleOffPageProps {
  /**
   * The module's name as the sidebar spells it — `ModuleDefinition.labelKey`
   * run through `t()` by the caller, so the operator's panel row, the nav entry
   * and this page all name the module with the same word.
   */
  moduleName: string;
}

const ModuleOffPage: React.FC<ModuleOffPageProps> = ({ moduleName }) => {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <EmptyState
      icon={PowerOff}
      title={t('moduleOff.title', { module: moduleName })}
      description={
        <>
          {t('moduleOff.body')}
          <br />
          {t('moduleOff.hint')}
        </>
      }
      action={
        <div className="grid grid-cols-1 gap-3 sm:flex sm:items-center">
          <Button variant="secondary" onClick={() => navigate('/overview')}>
            {t('locked.backToOverview')}
          </Button>
          <Button asChild>
            {/* The same mailbox LockedFeaturePage already writes to. */}
            <a href="mailto:support@el-professor.de?subject=Modul aktivieren">
              {t('moduleOff.contactSupport')}
            </a>
          </Button>
        </div>
      }
    />
  );
};

export default ModuleOffPage;
