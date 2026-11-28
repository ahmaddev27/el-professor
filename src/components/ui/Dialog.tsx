import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { cn } from './cn';

// Dialogs and sheets render into document.body, outside any themed wrapper, so
// they set the font themselves. The design tokens live on :root and .dark and
// reach the portal unchanged.

const scrimClass = 'glass-scrim motion-safe:data-[state=open]:animate-ui-fade-in';

const closeButtonClass = [
  'absolute end-3 top-3 inline-flex size-8 items-center justify-center rounded-tight text-fg-subtle transition-colors [@media(pointer:coarse)]:end-2 [@media(pointer:coarse)]:top-2 [@media(pointer:coarse)]:size-10',
  'hover:bg-sunken hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
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
    <DialogPrimitive.Overlay className={cn('fixed inset-0 z-50 grid place-items-center overflow-y-auto p-5', scrimClass)}>
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'relative grid w-full max-w-[560px] gap-4 glass-strong rounded-pane p-[22px] font-ui text-fg',
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
  return <div className={cn('grid gap-1.5 pe-8', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col-reverse gap-2 border-t border-line pt-3.5 sm:flex-row sm:justify-end', className)} {...props} />;
}

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('text-[17px] font-semibold leading-snug tracking-[-0.01em] text-fg', className)} {...props} />
));
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-[13px] text-fg-subtle', className)} {...props} />
));
DialogDescription.displayName = 'DialogDescription';

// ── Sheet: the same dialog, anchored to an edge ─────────────────────────────

const sheetVariants = cva(
  'fixed z-50 flex flex-col glass-drawer border-line font-ui text-fg focus:outline-none',
  {
    variants: {
      side: {
        // Below the staging banner when there is one; see EnvironmentBanner.
        right:
          'bottom-0 end-0 top-[var(--env-banner-height,0px)] w-full border-s sm:max-w-md motion-safe:data-[state=open]:animate-ui-slide-in-right motion-safe:data-[state=open]:rtl:animate-ui-slide-in-left',
        left: 'bottom-0 start-0 top-[var(--env-banner-height,0px)] w-[min(18rem,calc(100vw-3rem))] border-e motion-safe:data-[state=open]:animate-ui-slide-in-left motion-safe:data-[state=open]:rtl:animate-ui-slide-in-right',
        bottom:
          'inset-x-0 bottom-0 max-h-[90dvh] rounded-t-pane border-t motion-safe:data-[state=open]:animate-ui-slide-in-bottom',
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
  return <div className={cn('grid gap-1 border-b border-line px-6 py-5 pe-14', className)} {...props} />;
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
