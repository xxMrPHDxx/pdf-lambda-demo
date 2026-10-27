import type { JobStatus, Order } from "./types";

export function money(currency: string, amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

export function orderTotal(order: Order): number {
  return order.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
}

export function supplierCount(order: Order): number {
  return new Set(order.items.map((item) => item.supplier)).size;
}

export function documentCount(order: Order): number {
  return supplierCount(order);
}

export function formatDate(iso?: string): string {
  if (!iso) {
    return "-";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(iso?: string): string {
  if (!iso) {
    return "";
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) {
    return "-";
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function statusLabel(status: JobStatus): string {
  switch (status) {
    case "QUEUED":
      return "Queued";
    case "RUNNING":
      return "Running";
    case "FINALIZING":
      return "Packaging";
    case "COMPLETED":
      return "Ready";
    case "FAILED":
      return "Failed";
  }
}

export function shortJobId(jobId: string): string {
  const raw = jobId.replace(/^job_/, "");
  return raw.length > 10 ? raw.slice(0, 4) + "…" + raw.slice(-4) : raw;
}

export function percent(part: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((part / total) * 100)) : 0;
}
