import React from 'react';
import LanguageSwitcher from '../LanguageSwitcher';
import { Card, cn } from '../ui';
import BrandMark from './BrandMark';

interface AuthShellProps {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** `wide` holds the registration forms, whose plan cards sit three abreast. */
  width?: 'narrow' | 'wide';
  /** A row between the heading and the card, such as the signup steps. */
  above?: React.ReactNode;
}

/**
 * The frame of the signed-out screens: the brand, one heading, one card.
 *
 * On the design system since phase 5 batch 4, so it follows the theme. It is
 * the page's `main` landmark and its only `h1` (audit findings 21 and 17), and
 * it fills the viewport below the staging banner rather than the whole
 * viewport, so on staging the page does not scroll by the banner's height.
 */
const AuthShell: React.FC<AuthShellProps> = ({ title, subtitle, children, footer, width = 'narrow', above }) => (
  <main className="relative flex min-h-[calc(100dvh-var(--env-banner-height,0px))] flex-col items-center justify-center bg-canvas px-4 pb-10 pt-16 font-ui text-fg">
    <div className="absolute right-4 top-4">
      <LanguageSwitcher variant="ui" />
    </div>

    <div className={cn('w-full', width === 'wide' ? 'max-w-2xl' : 'max-w-sm')}>
      <header className="mb-6 flex flex-col items-center text-center">
        <BrandMark />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-full break-words text-sm text-fg-muted">{subtitle}</p>}
      </header>

      {above}

      <Card className="p-5 sm:p-7">{children}</Card>

      {footer && <div className="mt-6 grid justify-items-center gap-3 text-center">{footer}</div>}
    </div>
  </main>
);

export default AuthShell;
