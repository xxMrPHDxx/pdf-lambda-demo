# PDF Fulfilment Demo — Implementation Plan

## 1. Goal

End-to-end demo of an asynchronous PDF/ZIP fulfilment pipeline using AWS-shaped services:

- **React + Vite** portal: pick orders, watch live progress, download ZIP, inspect email.
- **NestJS** API: catalog, job creation, batching, queue admission, SSE progress.
- **Go** Lambdas: PDF worker (SQS trigger) and ZIP finaliser (SQS trigger).
- **S3**: PDF cache, ZIP cache, catalog snapshot, email copies.
- **SQS**: batch queue + finalise queue, each with a DLQ.
- **SES**: completion email with presigned ZIP link.
- **LocalStack** provides S3/SQS/SES/DynamoDB locally; **Redis** provides atomic admission slots.

Real AWS is supported by pointing the same env vars at AWS and disabling auto-provisioning (infra provisioning is out of scope).

## 2. Key decisions

| Topic | Decision |
| --- | --- |
| Order source | JSON catalog in S3 (`catalog/orders.json`), seeded by API if absent. Each job pins an order snapshot inside its batch rows. |
| PDF granularity | One PDF **per order per item supplier**. Orders may contain items from several suppliers; ZIP folders are supplier names. |
| PDF cache key | `pdfs/{clientId}/{orderId}/{supplierSlug}/{rev}-{status}-{contentHash}.pdf`. Content hash covers supplier items only. Any rev/status/item change produces a new key. |
| ZIP cache key | `zips/{clientId}/{filterHash}.zip`, where `filterHash` hashes the sorted per-order signature (order id + rev + status + item hash). TTL = 3 h (configurable). |
| PDF retention | S3 lifecycle expiry after 7 days (`pdfs/`), ZIP after 1 day (`zips/`). |
| Progress storage | DynamoDB single table (`pk`, `sk`) + 2 GSIs. Workers update per-document counters so SSE is smooth. |
| Live updates | SSE endpoint, backend polls Dynamo every 700 ms and emits changed snapshots per client. No websocket dependency. |
| Concurrency | Redis Lua-atomic admission: 10 running jobs globally, 2 per client. Scheduler promotes oldest `QUEUED` job when a slot frees. |
| Batch fan-out | One SQS message per batch (`batchSize=4` orders), worker processes documents concurrently (bounded). |
| Finalise trigger | Last completed batch sends one message to `finalize` queue. Worker is idempotent; zipper is idempotent and cache-aware. |
| Local Lambda execution | Same Go business logic is exposed two ways: `lambda.Start` handlers for AWS, and a `devrunner` SQS long-poll consumer for LocalStack. |
| Email | SES `SendEmail`. In local mode the rendered email is also stored at `emails/{jobId}.json` so the portal can preview it. |
| Frontend styling | Hand-written CSS (no Tailwind) for deterministic offline builds. |

## 3. Architecture

```
React portal ──REST/SSE──► NestJS API ──► DynamoDB (jobs, batches)
     │                        │  │
     │                        │  └──► Redis (admission slots, 10 global / 2 per client)
     │                        │
     │                        ├──► S3 (catalog, PDF cache, ZIP cache, emails)
     │                        └──► SQS batches queue ──► Go PDF worker (Lambda)
     │                                                       │
     │                                                       ├── S3 PDF cache (HEAD before render)
     │                                                       ├── Dynamo progress counters
     │                                                       └── SQS finalize queue (last batch)
     │                                                                │
     └────────── presigned GET ◄── S3 ZIP cache ◄── Go zipper (Lambda)
                                              └── SES email + S3 email copy
```

## 4. Flow

1. Portal loads catalog (`GET /api/orders?clientId=...`) and submits `POST /api/jobs`.
2. API validates orders/client, computes `filterHash`, splits orders into batches, writes job + batch rows as `QUEUED`.
3. Admission scheduler (1 s tick) reconciles stale slots, then atomically admits up to global/client limits, sets job `RUNNING`, sends batch messages.
4. PDF workers (SQS, concurrency = batch count) check S3 HEAD per document. Cache hit → count only; miss → render PDF, upload, count.
5. When a batch finishes, worker increments `batchesDone`. The worker that reaches `batchCount` publishes a finalise message.
6. Zipper checks `zips/{client}/{filterHash}.zip` freshness. Fresh → reuse; stale/missing → stream PDFs from S3 into supplier folders, upload ZIP.
7. Zipper sends SES email (presigned link), stores email copy, marks job `COMPLETED`.
8. API SSE pushes job snapshots; portal shows progress, cache stats, per-batch detail, download + email preview.
9. `POST /api/orders/:id/mutate` bumps `rev`/status → subsequent PDFs and ZIP get new cache keys (demonstrates invalidation).

## 5. Data model (DynamoDB)

Table `pdf-demo` — `pk` (S), `sk` (S), PAY_PER_REQUEST.

Job item:

```
pk = JOB#<jobId>            sk = META
clientId, email, status, createdAt, startedAt, finishedAt, error
orderIds[], batchSize, batchCount, batchesDone
pdfsTotal, pdfsDone, pdfsCached, pdfsGenerated
filterHash, zipKey, zipBytes, zipCached, downloadUrl, emailMessageId
supplierCounts (map)
gsi1pk = CLIENT#<clientId>  gsi1sk = <createdAt>#<jobId>
gsi2pk = STATUS#<status>    gsi2sk = <createdAt>#<jobId>
```

Batch item:

```
pk = JOB#<jobId>            sk = BATCH#<0001>
status (PENDING|PROCESSING|DONE|FAILED), orderIds[], orders[] (snapshot),
pdfsTotal, pdfsDone, pdfsCached, pdfsGenerated, startedAt, finishedAt, error, docs[]
doc = { orderId, supplier, key, fileName }
```

Statuses: `QUEUED → RUNNING → FINALIZING → COMPLETED | FAILED`.

## 6. Contracts

### REST

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/bootstrap?clientId=` | clients, limits, catalog summary, jobs |
| GET | `/api/orders?clientId=` | client catalog orders |
| POST | `/api/orders/:orderId/mutate` | bump rev / change status (cache invalidation demo) |
| POST | `/api/jobs` | `{clientId, orderIds[], email}` → job |
| GET | `/api/jobs?clientId=` | recent jobs + queue position |
| GET | `/api/jobs/:id` | job + batches |
| GET | `/api/jobs/:id/download` | 302 presigned ZIP |
| GET | `/api/jobs/:id/email` | stored email payload |
| POST | `/api/jobs/:id/retry` | retry failed job with new job id |
| GET | `/api/events?clientId=` | SSE snapshots (`jobs`, `limits`) |
| GET | `/api/health` | liveness + dependency states |

### SQS messages

```json
{ "type": "pdf.batch", "jobId": "…", "clientId": "acme", "batchIndex": 1, "orderIds": ["…"] }
{ "type": "pdf.finalize", "jobId": "…", "clientId": "acme" }
```

### Env

Shared AWS: `AWS_REGION`, `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
Resources: `S3_BUCKET`, `DDB_TABLE`, `SQS_BATCH_QUEUE`, `SQS_FINALIZE_QUEUE`, `REDIS_URL`.
Tuning: `BATCH_SIZE`, `MAX_RUNNING_JOBS`, `MAX_CLIENT_RUNNING_JOBS`, `PDF_CACHE_DAYS`, `ZIP_CACHE_HOURS`, `PDF_RENDER_DELAY_MS`, `SES_FROM`, `SES_SAVE_TO_S3`.
Public signing: `S3_PUBLIC_ENDPOINT` (browser-reachable LocalStack URL).

## 7. Milestones

### M0 — Scaffolding
- [x] Root workspaces, `.gitignore`, `.env.example`, Go module
- [x] Docker compose (LocalStack, Redis, API, workers, web)
- [x] Docs: PLAN.md, README.md

### M1 — Go pipeline
- [x] Shared config/domain/cache-key/store packages (order snapshots in batch rows)
- [x] PDF renderer (fpdf) with supplier table + totals
- [x] PDF worker: cache HEAD, render, counters, batch completion, finalise publish
- [x] Zipper: ZIP cache freshness, supplier folders, manifest, presigned URL, SES email
- [x] Lambda handlers + local dev runner (short poll, bounded concurrency)
- [x] Unit tests (cache keys, grouping, folder sanitisation, cache TTL, PDF output)

### M2 — NestJS API
- [x] AWS clients, boot-time resource provisioning, catalog seeding
- [x] Jobs CRUD, batching, filter hash, GSI listings
- [x] Redis limiter (Lua acquire/release/reconcile) + admission scheduler
- [x] SSE snapshots + limit/queue metadata
- [x] Order mutation, ZIP download redirect, email preview, health, retry
- [x] Type-check + build

### M3 — React portal
- [x] Order browser with filters/multi-select
- [x] Client switcher + limits banner + queue positions
- [x] Live job cards (SSE + polling fallback)
- [x] Batch detail, cache hit stats, ZIP download, email preview
- [x] Cache-busting demo action + toasts
- [x] Build

### M4 — Local verification
- [x] Compose stack healthy; LocalStack resources created
- [x] End-to-end job: PDFs generated, ZIP cached, email stored
- [x] Re-run same selection → PDF + ZIP cache hits
- [x] Mutate order → cache miss and new content
- [x] Concurrency limits observed (global 10, per-client 2)
- [x] Smoke script + README updated with verified commands

## 8. Test plan

**Unit (Go)** — deterministic cache keys, supplier grouping, slug/folder safety, ZIP TTL decision, PDF non-empty.

**Integration (local)** — `scripts/smoke.mjs`:
1. Wait for API health.
2. Create a job for 6 orders; poll until `COMPLETED` (timeout 120 s).
3. Assert ZIP exists (download bytes > 1 KB), PDF counters and SES email record.
4. Submit identical job; assert `zipCached=true` and PDF cache hits.
5. Mutate an order; submit again; assert new PDFs generated and `zipCached=false`.
6. Burst 12 jobs (acme) and assert `running <= 2`, `global <= 10`, queued jobs drain.

**Manual demo** — open portal, select orders, watch SSE, download ZIP, inspect email. Verified against the full Compose stack; smoke test passed 26/26 assertions, including presigned email downloads, cache hits, invalidation and the 2/10 admission limits.

## 9. Out of scope

- Real AWS Terraform/CDK (README documents required resources instead).
- AuthN/AuthZ, multi-tenant IAM, rate limiting per IP.
- Production observability (X-Ray, structured log shipping).
- Real order database and real email provider.
- Large-file streaming limits beyond demo ZIPs.
