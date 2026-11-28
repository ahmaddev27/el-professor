import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from './cn';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('glass-card rounded-surface text-fg', className)} {...props} />
));
Card.displayName = 'Card';

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-[18px] pt-4', className)} {...props} />
));
CardHeader.displayName = 'CardHeader';

interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  /** Heading level; pick the one that fits the page outline. */
  as?: 'h2' | 'h3' | 'h4';
}

export const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(({ className, as: Heading = 'h2', ...props }, ref) => (
  <Heading ref={ref} className={cn('font-ui text-[15px] font-semibold leading-snug tracking-[-0.01em] text-fg', className)} {...props} />
));
CardTitle.displayName = 'CardTitle';

export const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('mt-0.5 font-ui text-[13px] text-fg-subtle', className)} {...props} />
  ),
);
CardDescription.displayName = 'CardDescription';

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('px-[18px] pb-[18px] pt-4', className)} {...props} />
));
CardContent.displayName = 'CardContent';

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex items-center gap-2 border-t border-line px-[18px] py-3 text-[13px] text-fg-muted', className)} {...props} />
));
CardFooter.displayName = 'CardFooter';
