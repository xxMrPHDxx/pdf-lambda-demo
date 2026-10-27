import type { JobStatus } from "../types";
import { statusLabel } from "../utils";

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`status-badge status-${status.toLowerCase()}`}>
      <span className="status-dot" />
      {statusLabel(status)}
    </span>
  );
}
