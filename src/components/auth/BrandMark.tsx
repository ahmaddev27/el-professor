import React from 'react';
import { cn } from '../ui';

/**
 * The El-Professor mark and wordmark above the signed-out screens and the
 * account takeovers, in the variant for the theme on screen — the same brand
 * assets the design system's AppShell uses. The wordmark carries the name, so
 * the mark itself is decorative.
 */
const BrandMark: React.FC<{ size?: 'md' | 'sm'; className?: string }> = ({ size = 'md', className }) => {
  const mark = size === 'md' ? 'h-14' : 'h-11';
  const word = size === 'md' ? 'h-5' : 'h-4';
  return (
    <div className={cn('flex flex-col items-center gap-3', className)}>
      <img src="/brand/mark-on-light.png" alt="" className={cn(mark, 'w-auto dark:hidden')} />
      <img src="/brand/mark-on-dark.png" alt="" className={cn(mark, 'hidden w-auto dark:block')} />
      <img src="/brand/wordmark-on-light.png" alt="El-Professor" className={cn(word, 'w-auto dark:hidden')} />
      <img src="/brand/wordmark-on-dark.png" alt="El-Professor" className={cn(word, 'hidden w-auto dark:block')} />
    </div>
  );
};

export default BrandMark;
