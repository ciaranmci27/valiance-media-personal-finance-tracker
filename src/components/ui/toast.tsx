"use client";

import * as React from "react";
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle } from "lucide-react";

interface Toast {
  id: string;
  type: "success" | "error" | "info" | "warning";
  message: string;
}

let toasts: Toast[] = [];
let listeners: ((toasts: Toast[]) => void)[] = [];

function notify() {
  const snapshot = [...toasts];
  listeners.forEach((l) => l(snapshot));
}

export function toast(type: Toast["type"], message: string) {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const newToast: Toast = { id, type, message };

  // Limit to 5 visible toasts
  if (toasts.length >= 5) {
    toasts = toasts.slice(-4);
  }

  toasts = [...toasts, newToast];
  notify();

  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, 4000);
}

const icons = {
  success: <CheckCircle2 className="h-[18px] w-[18px] text-emerald-500 shrink-0" />,
  error: <AlertCircle className="h-[18px] w-[18px] text-red-500 shrink-0" />,
  info: <Info className="h-[18px] w-[18px] text-blue-500 shrink-0" />,
  warning: <AlertTriangle className="h-[18px] w-[18px] text-amber-500 shrink-0" />,
};

/* Solid raised surface + colored border, like the app's toasts - no tinted
   translucent body */
const bgColors = {
  success: "bg-[var(--background-subtle)] border-emerald-500/30",
  error: "bg-[var(--background-subtle)] border-red-500/30",
  info: "bg-[var(--background-subtle)] border-blue-500/30",
  warning: "bg-[var(--background-subtle)] border-amber-500/30",
};

export function ToastContainer() {
  const [visible, setVisible] = React.useState<Toast[]>([]);

  React.useEffect(() => {
    listeners.push(setVisible);
    return () => {
      listeners = listeners.filter((l) => l !== setVisible);
    };
  }, []);

  const dismiss = (id: string) => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  };

  if (visible.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
      {visible.map((t) => (
        <div
          key={t.id}
          className={`flex items-center gap-3 px-4 py-3 rounded-xl border shadow-[var(--shadow-overlay)] animate-in slide-in-from-right-5 fade-in duration-200 ${bgColors[t.type]}`}
        >
          {icons[t.type]}
          <span className="text-sm font-medium text-foreground">{t.message}</span>
          <button
            onClick={() => dismiss(t.id)}
            className="ml-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
