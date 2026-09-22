import React from 'react';
import { Mail, type LucideIcon } from 'lucide-react';
import { Card, cn } from '../ui';
import BrandMark from './BrandMark';

export type AccountStatusTone = 'caution' | 'critical';

interface AccountStatusPageProps {
  tone: AccountStatusTone;
  icon: LucideIcon;
  title: string;
  /** The explanation, one or more paragraphs. */
  children: React.ReactNode;
  /** The sentence before the support address. */
  contactLead: string;
  /** The page's own sign-out button: each takeover keeps its own handler. */
  action: React.ReactNode;
}

const TONE_CIRCLE: Record<AccountStatusTone, string> = {
  caution: 'bg-caution-soft text-caution',
  critical: 'bg-critical-soft text-critical',
};

/**
 * The frame of the four pages App.tsx shows instead of any screen: an account
 * that was blocked, and a company that is waiting for approval, was rejected
 * or is suspended. Phase 5 batch 4 moved them onto the design system together,
 * so they share this rather than four copies of the same card.
 *
 * It draws and nothing else. What each page says, and what its button does,
 * stays in the page.
 */
const AccountStatusPage: React.FC<AccountStatusPageProps> = ({ tone, icon: Icon, title, children, contactLead, action }) => (
  <main className="flex min-h-[calc(100dvh-var(--env-banner-height,0px))] items-center justify-center bg-canvas px-4 py-12 font-ui text-fg">
    <div className="w-full max-w-md">
      <BrandMark size="sm" className="mb-8" />
      <Card className="p-6 text-center sm:p-8">
        <div className={cn('mx-auto mb-5 flex size-14 items-center justify-center rounded-full', TONE_CIRCLE[tone])}>
          <Icon aria-hidden className="size-7" />
        </div>
        <h1 className="mb-3 text-xl font-semibold tracking-tight">{title}</h1>
        <div className="grid gap-4 text-sm leading-relaxed text-fg-muted">{children}</div>
        <div className="mt-6 flex items-start gap-3 rounded-control border border-line bg-sunken p-4 text-left text-sm text-fg-muted">
          <Mail aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
          <p>
            {contactLead}{' '}
            <a
              href="mailto:support@el-professor.de"
              className="font-medium text-brand-text underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              support@el-professor.de
            </a>
          </p>
        </div>
        <div className="mt-6">{action}</div>
      </Card>
    </div>
  </main>
);

export default AccountStatusPage;
