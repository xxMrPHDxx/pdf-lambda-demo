export interface ToastItem {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
}

export function Toasts({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toast-stack" aria-live="polite">
      {items.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span className="toast-mark" aria-hidden="true">
            {toast.kind === "success" ? "✓" : toast.kind === "error" ? "!" : "i"}
          </span>
          <span className="toast-text">{toast.text}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
