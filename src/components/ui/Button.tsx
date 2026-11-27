import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

export const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-control font-ui font-[550] tracking-[-0.005em]',
    'transition-[background-color,box-shadow,color,transform] duration-150 ease-glass motion-safe:active:translate-y-px motion-safe:active:scale-[.99]',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75]',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-brand-gradient text-brand-fg shadow-brand hover:bg-brand-gradient-hover',
        secondary: 'border border-edge bg-raised text-fg shadow-raised hover:bg-raised/[1.4]',
        ghost: 'text-fg-muted hover:bg-raised hover:text-fg',
        danger: 'bg-critical-solid text-critical-fg hover:brightness-95',
        link: 'text-brand-text underline-offset-4 hover:underline',
      },
      // A mouse keeps the denser sizes. A finger (a coarse pointer: phones,
      // tablets) gets 40 to 44 px, the size WCAG 2.5.5 and Apple recommend.
      size: {
        sm: 'h-[30px] rounded-tight px-2.5 text-[12.5px] [&_svg]:size-[15px] [@media(pointer:coarse)]:h-10',
        md: 'h-9 px-3.5 text-[13.5px] [@media(pointer:coarse)]:h-11',
        lg: 'h-11 rounded-tile px-5 text-[14.5px] [@media(pointer:coarse)]:h-12',
        icon: 'size-9 [@media(pointer:coarse)]:size-11',
        'icon-sm': 'size-[30px] rounded-tight [&_svg]:size-[15px] [@media(pointer:coarse)]:size-10',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0 [@media(pointer:coarse)]:h-auto [@media(pointer:coarse)]:min-h-10' }],
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
