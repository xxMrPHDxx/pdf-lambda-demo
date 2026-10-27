export type OrderStatus = "confirmed" | "paid" | "packing" | "shipped";
export type JobStatus = "QUEUED" | "RUNNING" | "FINALIZING" | "COMPLETED" | "FAILED";
export type BatchStatus = "PENDING" | "PROCESSING" | "DONE" | "FAILED";

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

export interface Customer {
  name: string;
  email: string;
  address: string;
}

export interface Order {
  id: string;
  clientId: string;
  rev: number;
  status: OrderStatus;
  currency: string;
  placedAt: string;
  customer: Customer;
  items: OrderItem[];
}

export interface Catalog {
  version: number;
  updatedAt: string;
  clients: Client[];
  orders: Order[];
}

export interface DocRef {
  orderId: string;
  supplier: string;
  key: string;
  fileName: string;
}

export interface BatchRecord {
  pk: string;
  sk: string;
  jobId: string;
  batchIndex: number;
  status: BatchStatus;
  orderIds: string[];
  orders: Order[];
  pdfsTotal: number;
  pdfsDone: number;
  pdfsCached: number;
  pdfsGenerated: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  docs?: DocRef[];
}

export interface JobRecord {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  gsi2pk: string;
  gsi2sk: string;
  jobId: string;
  clientId: string;
  clientName: string;
  email: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  orderIds: string[];
  batchSize: number;
  batchCount: number;
  batchesDone: number;
  pdfsTotal: number;
  pdfsDone: number;
  pdfsCached: number;
  pdfsGenerated: number;
  filterHash: string;
  zipKey?: string;
  zipBytes?: number;
  zipCached?: boolean;
  downloadUrl?: string;
  emailMessageId?: string;
  emailError?: string;
  supplierCounts?: Record<string, number>;
}

export interface BatchDto {
  index: number;
  status: BatchStatus;
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

export interface Limits {
  globalRunning: number;
  globalLimit: number;
  clientRunning: number;
  clientLimit: number;
  queuedJobs: number;
}

export interface LimitsSnapshot {
  jobs: JobDto[];
  limits: Limits;
  serverTime: string;
}

export interface BootstrapResponse extends LimitsSnapshot {
  clients: Client[];
  suppliers: string[];
  orders: Order[];
  catalogVersion: number;
  catalogUpdatedAt: string;
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
