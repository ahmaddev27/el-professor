import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { cn } from './cn';

// Dialogs and sheets render into document.body, outside any themed wrapper, so
// they set the font themselves. The design tokens live on :root and .dark and
// reach the portal unchanged.

const scrimClass = 'bg-[rgb(5_8_16/0.55)] motion-safe:data-[state=open]:animate-ui-fade-in';

const closeButtonClass = [
  'absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-control text-fg-subtle transition-colors',
  'hover:bg-sunken hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus',
].join(' ');

function CloseButton() {
  const { t } = useTranslation();
  return (
    <DialogPrimitive.Close className={closeButtonClass} aria-label={t('common.close')}>
      <X aria-hidden className="size-4" />
    </DialogPrimitive.Close>
  );
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose = false, ...props }, ref) => (
  <DialogPrimitive.Portal>
    {/* The overlay doubles as the scroll container, so a tall dialog scrolls
        instead of being cut off, and centring needs no transform that the
        entry animation would fight with. */}
    <DialogPrimitive.Overlay className={cn('fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4', scrimClass)}>
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'relative grid w-full max-w-lg gap-5 rounded-surface border border-line bg-overlay p-6 font-ui text-fg shadow-overlay',
          'focus:outline-none motion-safe:data-[state=open]:animate-ui-pop-in',
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : <CloseButton />}
      </DialogPrimitive.Content>
    </DialogPrimitive.Overlay>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = 'DialogContent';

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('grid gap-1.5 pr-8', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />;
}

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('text-lg font-semibold leading-snug text-fg', className)} {...props} />
));
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-sm text-fg-muted', className)} {...props} />
));
DialogDescription.displayName = 'DialogDescription';

// ── Sheet: the same dialog, anchored to an edge ─────────────────────────────

const sheetVariants = cva(
  'fixed z-50 flex flex-col border-line bg-overlay font-ui text-fg shadow-overlay focus:outline-none',
  {
    variants: {
      side: {
        // Below the staging banner when there is one; see EnvironmentBanner.
        right:
          'bottom-0 right-0 top-[var(--env-banner-height,0px)] w-full border-l sm:max-w-md motion-safe:data-[state=open]:animate-ui-slide-in-right',
        left: 'bottom-0 left-0 top-[var(--env-banner-height,0px)] w-[min(18rem,calc(100vw-3rem))] border-r motion-safe:data-[state=open]:animate-ui-slide-in-left',
        bottom:
          'inset-x-0 bottom-0 max-h-[90dvh] rounded-t-surface border-t motion-safe:data-[state=open]:animate-ui-slide-in-bottom',
      },
    },
    defaultVariants: { side: 'right' },
  },
);

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export const SheetContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & VariantProps<typeof sheetVariants> & { hideClose?: boolean }
>(({ className, children, side, hideClose = false, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={cn('fixed inset-0 z-50', scrimClass)} />
    <DialogPrimitive.Content ref={ref} className={cn(sheetVariants({ side }), className)} {...props}>
      {children}
      {hideClose ? null : <CloseButton />}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = 'SheetContent';

export function SheetHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('grid gap-1 border-b border-line px-6 py-5 pr-14', className)} {...props} />;
}

export function SheetBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex-1 overflow-y-auto px-6 py-5', className)} {...props} />;
}

export function SheetFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 border-t border-line px-6 py-4 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export const SheetTitle = DialogTitle;
export const SheetDescription = DialogDescription;
