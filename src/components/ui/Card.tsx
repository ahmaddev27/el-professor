import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from './cn';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('rounded-surface border border-line bg-raised text-fg shadow-raised', className)} {...props} />
));
Card.displayName = 'Card';

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-5', className)} {...props} />
));
CardHeader.displayName = 'CardHeader';

interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  /** Heading level; pick the one that fits the page outline. */
  as?: 'h2' | 'h3' | 'h4';
}

export const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(({ className, as: Heading = 'h2', ...props }, ref) => (
  <Heading ref={ref} className={cn('font-ui text-[15px] font-semibold leading-snug text-fg', className)} {...props} />
));
CardTitle.displayName = 'CardTitle';

export const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('mt-0.5 font-ui text-[13px] text-fg-subtle', className)} {...props} />
  ),
);
CardDescription.displayName = 'CardDescription';

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('px-5 pb-5 pt-4', className)} {...props} />
));
CardContent.displayName = 'CardContent';

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex items-center gap-2 border-t border-line px-5 py-3', className)} {...props} />
));
CardFooter.displayName = 'CardFooter';
