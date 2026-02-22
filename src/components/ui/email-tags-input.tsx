"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmailTagsInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  label?: string;
  helperText?: string;
  className?: string;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function EmailTagsInput({
  value,
  onChange,
  placeholder = "Enter email address",
  required,
  label,
  helperText,
  className,
}: EmailTagsInputProps) {
  const [inputValue, setInputValue] = React.useState("");
  const [isFocused, setIsFocused] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Parse value into array of emails
  const emails = React.useMemo(() => {
    return value
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
  }, [value]);

  // Update parent value from emails array
  const updateValue = (newEmails: string[]) => {
    onChange(newEmails.join(", "));
  };

  // Add email(s) from input
  const addEmails = (input: string) => {
    const newEmails = input
      .split(/[,\s]+/)
      .map((e) => e.trim())
      .filter((e) => e && isValidEmail(e) && !emails.includes(e));

    if (newEmails.length > 0) {
      updateValue([...emails, ...newEmails]);
    }
    setInputValue("");
  };

  // Remove email by index
  const removeEmail = (index: number) => {
    const newEmails = emails.filter((_, i) => i !== index);
    updateValue(newEmails);
  };

  // Handle key down events
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      if (inputValue.trim()) {
        e.preventDefault();
        addEmails(inputValue);
      } else if (e.key === ",") {
        // Prevent comma from being typed when empty
        e.preventDefault();
      }
    } else if (e.key === "Tab" && inputValue.trim()) {
      // Only handle Tab if there's content to add
      e.preventDefault();
      addEmails(inputValue);
    } else if (e.key === "Backspace" && !inputValue && emails.length > 0) {
      // Remove last email when backspace on empty input
      removeEmail(emails.length - 1);
    }
  };

  // Handle paste
  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedText = e.clipboardData.getData("text");
    addEmails(pastedText);
  };

  // Handle blur - add any pending email
  const handleBlur = () => {
    setIsFocused(false);
    if (inputValue.trim()) {
      addEmails(inputValue);
    }
  };

  // Focus input when clicking container
  const handleContainerClick = () => {
    inputRef.current?.focus();
  };

  return (
    <div className={className}>
      {label && (
        <label className="text-sm font-medium mb-1.5 block">
          {label}
          {required && <span className="text-error ml-0.5">*</span>}
        </label>
      )}
      <div
        onClick={handleContainerClick}
        className={cn(
          "flex flex-wrap gap-1.5 p-2 min-h-[42px] rounded-lg border bg-background transition-colors cursor-text",
          isFocused
            ? "border-primary ring-1 ring-primary/20"
            : "border-input hover:border-primary/50"
        )}
      >
        {/* Email tags */}
        {emails.map((email, index) => (
          <span
            key={`${email}-${index}`}
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-sm font-medium transition-colors",
              isValidEmail(email)
                ? "bg-primary/10 text-primary"
                : "bg-error/10 text-error"
            )}
          >
            {email}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeEmail(index);
              }}
              className="hover:bg-primary/20 rounded p-0.5 -mr-0.5 transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}

        {/* Input field */}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => setIsFocused(true)}
          onBlur={handleBlur}
          placeholder={emails.length === 0 ? placeholder : "Add another..."}
          className="flex-1 min-w-[150px] bg-transparent outline-none text-sm placeholder:text-muted-foreground"
        />
      </div>
      {helperText && (
        <p className="text-xs text-muted-foreground mt-1.5">{helperText}</p>
      )}
    </div>
  );
}
