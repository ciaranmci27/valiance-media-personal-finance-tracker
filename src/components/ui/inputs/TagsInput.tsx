'use client';
import { useState, useRef, useEffect, forwardRef } from 'react';
import { X } from 'lucide-react';
import { mergeRefs, type InputSize } from './_shared';
import { TextInput } from './TextInput';
/** Accessible, token-based TagsInput configuration. */
export interface TagsInputProps {
  size?: InputSize;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  type?: 'text' | 'email';
}
export const TagsInput = forwardRef<HTMLInputElement, TagsInputProps>(function TagsInput(
  {
    value,
    onChange,
    label,
    description,
    placeholder,
    required,
    disabled,
    className,
    size = 'default',
    error: externalError,
    type = 'text',
  },
  ref,
) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.setCustomValidity(error || externalError || '');
  }, [error, externalError]);
  const tags = value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const add = (text: string) => {
    const next = text
      .split(type === 'email' ? /[,\s]+/ : /,/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (type === 'email' && next.some((tag) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tag))) {
      setError('Enter a valid email address.');
      setDraft(text);
      return;
    }
    if (next.length) onChange([...new Set([...tags, ...next])].join(', '));
    setDraft('');
    setError(undefined);
  };
  const remove = (index: number) => onChange(tags.filter((_, i) => i !== index).join(', '));
  return (
    <div className={`space-y-2 ${className || ''}`}>
      <TextInput
        ref={mergeRefs(input, ref)}
        size={size}
        type={type}
        label={label}
        aria-label={label || 'Tags'}
        description={description}
        value={draft}
        placeholder={placeholder || (type === 'email' ? 'Enter email address' : 'Add a tag')}
        required={required && !tags.length}
        disabled={disabled}
        error={error || externalError}
        onChange={(value) => {
          setDraft(value);
          setError(undefined);
        }}
        onBlur={() => {
          if (draft.trim()) add(draft);
        }}
        onPaste={(event) => {
          event.preventDefault();
          add(event.clipboardData.getData('text'));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            add(draft);
          } else if (event.key === 'Tab' && draft.trim()) add(draft);
          else if (event.key === 'Backspace' && !draft && tags.length) remove(tags.length - 1);
        }}
      />
      {tags.length > 0 && (
        <ul aria-label="Selected tags" className="flex flex-wrap gap-1.5">
          {tags.map((tag, index) => (
            <li
              key={tag}
              className="inline-flex items-center gap-1 rounded-input-sm bg-input-accent-subtle px-2 py-1 text-sm text-input-accent-subtle-fg"
            >
              {tag}
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${tag}`}
                onClick={() => remove(index)}
                className="rounded-input-sm p-0.5 hover:bg-input-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-ring"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
