import type {
  BootstrapResponse,
  HealthResponse,
  JobDetail,
  Snapshot,
  StoredEmail,
  Order,
} from "./types";

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as { message?: string | string[] };
      if (payload.message) {
        message = Array.isArray(payload.message) ? payload.message.join(", ") : payload.message;
      }
    } catch {
      // Ignore non-JSON error bodies.
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  bootstrap: (clientId: string) =>
    request<BootstrapResponse>(`/api/bootstrap?clientId=${encodeURIComponent(clientId)}`),
  snapshot: (clientId: string) =>
    request<Snapshot>(`/api/jobs?clientId=${encodeURIComponent(clientId)}`),
  createJob: (input: { clientId: string; orderIds: string[]; email: string }) =>
    request<{ job: JobDetail["job"] }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  mutateOrder: (orderId: string) =>
    request<{ order: Order; message: string }>(
      `/api/orders/${encodeURIComponent(orderId)}/mutate`,
      { method: "POST", body: JSON.stringify({ bumpRev: true, qtyDelta: 1 }) },
    ),
  jobDetail: (jobId: string) => request<JobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`),
  email: (jobId: string) => request<StoredEmail>(`/api/jobs/${encodeURIComponent(jobId)}/email`),
  retry: (jobId: string) =>
    request<{ job: JobDetail["job"] }>(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
      method: "POST",
    }),
  health: () => request<HealthResponse>("/api/health"),
};

export function downloadUrl(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/download`;
}

export { ApiError };
