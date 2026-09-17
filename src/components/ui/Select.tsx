import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { cn } from './cn';
import { useFieldControlProps } from './Field';
import { controlFrameClass } from './Input';

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;

/** The chosen option's text, or a placeholder in the UI language while nothing is chosen. */
export const SelectValue = forwardRef<
  ElementRef<typeof SelectPrimitive.Value>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Value>
>(({ placeholder, ...props }, ref) => {
  const { t } = useTranslation();
  return <SelectPrimitive.Value ref={ref} placeholder={placeholder ?? t('ui.select.placeholder')} {...props} />;
});
SelectValue.displayName = 'SelectValue';

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & { invalid?: boolean }
>(({ className, children, id, invalid, 'aria-describedby': describedBy, ...props }, ref) => {
  const controlProps = useFieldControlProps({ id, describedBy, invalid });
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        controlFrameClass,
        'flex items-center justify-between gap-2 text-left data-[placeholder]:text-fg-subtle [&>span]:truncate',
        className,
      )}
      {...props}
      {...controlProps}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-fg-subtle" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});
SelectTrigger.displayName = 'SelectTrigger';

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', sideOffset = 4, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      sideOffset={position === 'popper' ? sideOffset : undefined}
      className={cn(
        'relative z-[60] max-h-[min(var(--radix-select-content-available-height),20rem)] min-w-[var(--radix-select-trigger-width)]',
        'overflow-hidden rounded-control border border-line bg-overlay font-ui text-fg shadow-overlay',
        'motion-safe:data-[state=open]:animate-ui-pop-in',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = 'SelectContent';

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex h-9 cursor-default select-none items-center rounded-[calc(var(--radius-control)-2px)] pl-8 pr-3 text-sm outline-none [@media(pointer:coarse)]:h-11',
      'data-[highlighted]:bg-sunken data-[state=checked]:font-semibold data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-4 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check aria-hidden className="size-4 text-brand-text" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = 'SelectItem';
