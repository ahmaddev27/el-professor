import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from './cn';
import { useFieldControlProps } from './Field';

/**
 * Shared by Input and SelectTrigger so every control has the same frame.
 *
 * On a touch screen the frame grows to 44 px, and the text to 16 px: iOS zooms
 * the whole page into any field whose text is smaller when it is tapped.
 */
export const controlFrameClass = [
  'h-10 w-full min-w-0 rounded-control border border-line-strong bg-field px-3 font-ui text-sm text-fg shadow-field',
  '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-base',
  'transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-fg-subtle',
  'focus-visible:border-brand focus-visible:bg-solid/90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus/25',
  'aria-[invalid=true]:border-critical aria-[invalid=true]:focus-visible:ring-critical/15',
  'disabled:cursor-not-allowed disabled:bg-sunken disabled:text-fg-subtle',
].join(' ');

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, id, invalid, 'aria-describedby': describedBy, ...props }, ref) => {
    const controlProps = useFieldControlProps({ id, describedBy, invalid });
    return (
      <input
        ref={ref}
        className={cn(
          controlFrameClass,
          // Native date pickers follow the page's colour scheme only when told.
          'tabular-nums [color-scheme:light] dark:[color-scheme:dark]',
          className,
        )}
        {...props}
        {...controlProps}
      />
    );
  },
);
Input.displayName = 'Input';
