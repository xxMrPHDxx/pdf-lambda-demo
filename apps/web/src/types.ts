export type OrderStatus = "confirmed" | "paid" | "packing" | "shipped";
export type JobStatus = "QUEUED" | "RUNNING" | "FINALIZING" | "COMPLETED" | "FAILED";

export interface Client {
  id: string;
  name: string;
  email: string;
  initials: string;
}

export interface OrderItem {
  sku: string;
  description: string;
  qty: number;
  unitPrice: number;
  supplier: string;
}

export interface Order {
  id: string;
  clientId: string;
  rev: number;
  status: OrderStatus;
  currency: string;
  placedAt: string;
  customer: { name: string; email: string; address: string };
  items: OrderItem[];
}

export interface JobDto {
  jobId: string;
  clientId: string;
  clientName: string;
  email: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  orderCount: number;
  batchCount: number;
  batchesDone: number;
  pdfsTotal: number;
  pdfsDone: number;
  pdfsCached: number;
  pdfsGenerated: number;
  percent: number;
  zipBytes?: number;
  zipCached?: boolean;
  emailMessageId?: string;
  emailError?: string;
  supplierCounts?: Record<string, number>;
  queuePosition?: number;
  canDownload: boolean;
}

export interface BatchDto {
  index: number;
  status: "PENDING" | "PROCESSING" | "DONE" | "FAILED";
  orderIds: string[];
  orderCount: number;
  pdfsTotal: number;
  pdfsDone: number;
  pdfsCached: number;
  pdfsGenerated: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  documents: number;
}

export interface Limits {
  globalRunning: number;
  globalLimit: number;
  clientRunning: number;
  clientLimit: number;
  queuedJobs: number;
}

export interface Snapshot {
  jobs: JobDto[];
  limits: Limits;
  serverTime: string;
}

export interface BootstrapResponse extends Snapshot {
  clients: Client[];
  suppliers: string[];
  orders: Order[];
  catalogVersion: number;
  catalogUpdatedAt: string;
}

export interface JobDetail {
  job: JobDto;
  batches: BatchDto[];
}

export interface StoredEmail {
  jobId: string;
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  downloadUrl?: string;
  zipCached?: boolean;
  documents?: number;
  messageId?: string;
  error?: string;
  sentAt?: string;
}

export interface HealthResponse {
  status: string;
  checks: Record<string, string>;
  resources: Record<string, string>;
  limits: { global: number; perClient: number; batchSize: number };
  provisioned: boolean;
  serverTime: string;
}
