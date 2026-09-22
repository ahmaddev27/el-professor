import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn';
import { useFieldControlProps } from './Field';
import { controlFrameClass } from './Input';

export interface NativeSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  /** Classes for the wrapper that holds the select and its chevron, e.g. a width. */
  containerClassName?: string;
}

/**
 * The browser's own <select> in the design system's frame.
 *
 * Phase 5 moves screens whose selects carry logic in their `onChange` (a month
 * turned back into a number, an import chosen by id). The Radix Select hands
 * its value over through `onValueChange` instead, so swapping one for the other
 * would rewrite handlers a look-only change must leave alone. This keeps the
 * element and its events and changes only what it looks like; on a phone it is
 * also the native picker, which is what a finger wants.
 *
 * Inside a Field it is labelled, described and marked invalid like Input.
 */
export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, containerClassName, id, invalid, 'aria-describedby': describedBy, children, ...props }, ref) => {
    const controlProps = useFieldControlProps({ id, describedBy, invalid });
    return (
      <div className={cn('relative min-w-0', containerClassName)}>
        <select
          ref={ref}
          className={cn(
            controlFrameClass,
            // The open list follows the page's colour scheme only when told.
            'cursor-pointer appearance-none pr-9 [color-scheme:light] dark:[color-scheme:dark]',
            className,
          )}
          {...props}
          {...controlProps}
        >
          {children}
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
      </div>
    );
  },
);
NativeSelect.displayName = 'NativeSelect';
