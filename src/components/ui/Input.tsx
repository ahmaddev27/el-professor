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
  'h-9 w-full min-w-0 rounded-control border border-line-strong bg-field px-3 font-ui text-sm text-fg',
  '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-base',
  'transition-colors placeholder:text-fg-subtle',
  'focus-visible:border-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus',
  'aria-[invalid=true]:border-critical disabled:cursor-not-allowed disabled:opacity-50',
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
