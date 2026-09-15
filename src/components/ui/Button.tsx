import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

export const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-control font-ui font-semibold',
    'transition-colors duration-150 motion-safe:active:translate-y-px',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-brand text-brand-fg hover:bg-brand-hover',
        secondary: 'border border-line bg-raised text-fg hover:bg-sunken',
        ghost: 'text-fg-muted hover:bg-sunken hover:text-fg',
        danger: 'bg-critical-solid text-brand-fg hover:bg-critical-solid/90',
        link: 'text-brand-text underline-offset-4 hover:underline',
      },
      // A mouse keeps the denser sizes. A finger (a coarse pointer: phones,
      // tablets) gets 40 to 44 px, the size WCAG 2.5.5 and Apple recommend.
      size: {
        sm: 'h-8 px-3 text-[13px] [@media(pointer:coarse)]:h-10',
        md: 'h-9 px-3.5 text-sm [@media(pointer:coarse)]:h-11',
        lg: 'h-11 px-5 text-[15px]',
        icon: 'size-9 [@media(pointer:coarse)]:size-11',
        'icon-sm': 'size-8 [@media(pointer:coarse)]:size-10',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0 [@media(pointer:coarse)]:h-auto' }],
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render the styles onto the single child element, e.g. a router link. */
  asChild?: boolean;
  /** Shows a spinner and blocks further clicks while an action runs. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, type, ...props }, ref) => {
    const classes = cn(buttonVariants({ variant, size }), className);

    if (asChild) {
      return (
        <Slot ref={ref} className={classes} {...props}>
          {children}
        </Slot>
      );
    }

    return (
      <button
        ref={ref}
        // A button inside a form submits it unless told otherwise; default to
        // the harmless kind so only an explicit type="submit" sends a form.
        type={type ?? 'button'}
        className={classes}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? <Loader2 aria-hidden className="motion-safe:animate-spin" /> : null}
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';
