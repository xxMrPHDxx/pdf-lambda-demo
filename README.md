# PDF Fulfilment Pipeline — AWS Demo

Asynchronous order-to-PDF-to-ZIP pipeline demo built with **React**, **NestJS**, **Go Lambdas**, **SQS**, **S3**, **SES**, **DynamoDB**, and **Redis** for queue admission. Local development runs on **LocalStack**; the same code is deployed to AWS on EC2 with real SQS, S3, SES, DynamoDB and Lambda.

> Select orders → batches queue up → Lambda renders PDFs (S3 cached) → finaliser builds a supplier-grouped ZIP (cached) → SES email with a presigned download link → live progress in the portal.

## Live AWS deployment

| Endpoint | URL |
| --- | --- |
| Portal — Cloudflare Tunnel (HTTPS, recommended) | https://pdf-lambda-demo.xxmrphdxx.my |
| Portal — raw EC2 Elastic IP (HTTP) | http://54.208.30.72 |
| API health — Cloudflare Tunnel | https://pdf-lambda-demo.xxmrphdxx.my/api/health |
| API health — raw EC2 Elastic IP | http://54.208.30.72/api/health |

The AWS deployment uses `us-east-1`: one EC2 `t3.micro` running nginx + NestJS + Redis, two Go Lambdas (`pdfworker`, `zipper`), SQS batch/finalize queues with DLQs, S3 caches, DynamoDB, SES and Cloudflare Tunnel ingress. The notification email is configured for the verified SES sandbox address.

The local Docker/LocalStack workflow below is for development; the live portal does not require it.

## Stack

| Layer | Tech |
| --- | --- |
| Portal | React 18, Vite, TypeScript, SSE, hand-written CSS |
| API | NestJS 11, AWS SDK v3, DynamoDB, SQS, S3, ioredis |
| Workers | Go 1.25, `aws-lambda-go`, AWS SDK v2, `go-pdf/fpdf`, `archive/zip` |
| AWS services | SQS (+DLQs), S3 (+lifecycle), SES, DynamoDB |
| Local infra | LocalStack, Redis 7, Docker Compose |

## Local quick start (Docker + LocalStack)

Prerequisites: Docker Desktop with Compose, Node 20+ (only for the smoke test), AWS CLI (optional).

```bash
docker compose up --build -d
```

Wait for the API to report healthy (`docker compose ps`), then open http://localhost:8080.

- Portal: http://localhost:8080
- API: http://localhost:3000/api/health
- LocalStack: http://localhost:4566
- Redis: localhost:6379

The API provisions LocalStack on boot: buckets, tables, queues, SES identity, catalog seed. First build takes a few minutes; startup takes ~30–60 s. Reset everything with `docker compose down -v && docker compose up -d`.

Demo loop:

1. Pick a client (Acme, Globex, Initech, Umbrella, Stark, Wayne).
2. Filter orders, tick several, click **Generate PDF pack**.
3. Watch the queue position, per-batch progress, PDF cache vs generated counts.
4. Open a completed job → **Download ZIP**, **Email preview**, supplier folder breakdown.
5. Submit the same selection again → PDF and ZIP cache hits.
6. Click **simulate external change** on an order, submit again → cache miss and regenerated PDF.
7. Submit several jobs for one client → only 2 run, the rest queue. Repeat across clients to see the 10-job global cap.

Run the automated smoke test:

```bash
node scripts/smoke.mjs
```

## Local dev (apps on host)

Start dependencies only:

```bash
docker compose up -d localstack redis
```

```bash
npm install
cp .env.example .env             # LocalStack endpoints + test credentials
npm run dev -w apps/api          # NestJS on :3000
npm run dev -w apps/web          # Vite on :5173 (proxies /api)
```

Workers (separate terminals, Go 1.25). Start the API first so LocalStack resources and the catalog exist:

```bash
cd lambdas
go run ./cmd/devrunner -role pdfworker
go run ./cmd/devrunner -role zipper
```

The Go defaults point at `http://localhost:4566` and automatically use LocalStack's `test`/`test` credentials when no AWS credentials are present. Copy `.env.example` to `.env` at the repo root only when you need to override defaults (the API loads it).

## Architecture

```
React ──REST/SSE──► NestJS ──► DynamoDB (jobs/batches) + Redis (slots)
                      │
                      ├──► S3 catalog
                      ├──► SQS batches ──► Go PDF worker ──► S3 PDF cache
                      │                                  └──► SQS finalize
                      └──► presigned ZIP ◄── S3 ZIP cache ◄── Go zipper
                                                         └──► SES email
```

Detailed design and decisions: [PLAN.md](PLAN.md).

### Batching and concurrency

- Each job splits selected orders into batches of `BATCH_SIZE` (default 4).
- Each order produces **one PDF per distinct item supplier**, so a mixed-supplier order yields multiple documents and a ZIP folder per supplier.
- The API snapshots the selected orders into batch rows at submission. Later catalog edits affect new jobs only, keeping a running job internally consistent.
- One SQS message per batch; Lambda/reserved concurrency processes batches in parallel.
- Admission is job-level: **10 running jobs globally**, **2 per client**. Queued jobs are promoted oldest-first by a 1 s scheduler tick. Redis Lua scripts make `SCARD` checks + `SADD` atomic. Slots are reconciled against DynamoDB every tick, so crashes cannot leak capacity.
- Workers update per-document counters, so SSE progress moves within a batch.

### Caching

| Artifact | Key | Freshness |
| --- | --- | --- |
| PDF | `pdfs/{client}/{orderId}/{supplier}/{rev}-{status}-{itemHash}.pdf` | S3 lifecycle 7 days; rev/status/item change → new key |
| ZIP | `zips/{client}/{filterHash}.zip` | `ZIP_CACHE_HOURS` (default 3 h), checked via `LastModified`; key covers all orders + revs + statuses + item hashes |
| Email copy | `emails/{jobId}.json` | audit/demo preview |
| Catalog | `catalog/orders.json` | seeded if missing; mutate endpoint rewrites it |

PDFs are grouped into supplier folders inside the ZIP (`Nordic Paper Co/ac-1001-nordic-paper-co.pdf`). The ZIP also contains `manifest.json` and `README.txt`.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | API port |
| `AWS_REGION` | `us-east-1` | |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | Empty for real AWS |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` | LocalStack |
| `S3_BUCKET` | `pdf-demo` | |
| `DDB_TABLE` | `pdf-demo` | |
| `SQS_BATCH_QUEUE` | `http://localhost:4566/000000000000/pdf-demo-batches` | Queue URL |
| `SQS_FINALIZE_QUEUE` | `http://localhost:4566/000000000000/pdf-demo-finalize` | Queue URL |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:4566` | Used only for presigned URLs |
| `REDIS_URL` | `redis://localhost:6379` | |
| `AUTO_PROVISION` | `true` | Create LocalStack resources on boot; set `false` on AWS |
| `BATCH_SIZE` | `4` | |
| `MAX_RUNNING_JOBS` | `10` | Global admission limit |
| `MAX_CLIENT_RUNNING_JOBS` | `2` | Per-client limit |
| `PDF_RENDER_DELAY_MS` | `150` | Simulated render cost, helps demo concurrency |
| `PDF_CACHE_DAYS` | `7` | Lifecycle rule |
| `ZIP_CACHE_HOURS` | `3` | ZIP reuse window |
| `SES_FROM` | `orders@pdfdemo.local` | Verify in real AWS |
| `SES_SAVE_TO_S3` | `true` | Store email JSON copy |
| `PORTAL_URL` | `http://localhost:8080` | Link included in the completion email (worker) |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:8080` | |

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/bootstrap?clientId=acme` | Limits, clients, orders summary, recent jobs |
| GET | `/api/orders?clientId=acme` | Catalog orders |
| POST | `/api/orders/:orderId/mutate` | `{status?, bumpRev?}` — invalidate caches |
| POST | `/api/jobs` | `{clientId, orderIds, email?}` |
| GET | `/api/jobs?clientId=acme` | Recent jobs with progress/queue position |
| GET | `/api/jobs/:id` | Job + batch detail |
| GET | `/api/jobs/:id/download` | 302 to presigned ZIP |
| GET | `/api/jobs/:id/email` | Stored SES payload |
| POST | `/api/jobs/:id/retry` | Clone a failed job |
| GET | `/api/events?clientId=acme` | SSE snapshots |
| GET | `/api/health` | Dependency health |

## Repository layout

```
apps/api          NestJS API, scheduler, SSE, infra bootstrap
apps/web          React portal
lambdas           Go module: pdfworker, zipper, devrunner, shared internal packages
scripts           smoke test
docker            Dockerfiles
docker-compose.yml
PLAN.md           Design + milestone plan
```

## AWS deployment notes

1. Build Lambda zips: `cd lambdas && make build-lambda` (uses `provided.al2023`, handler `bootstrap`; outputs `dist/pdfworker.zip` and `dist/zipper.zip`).
2. Create S3 bucket, DynamoDB table (`pk`/`sk` + GSIs `gsi1pk/gsi1sk`, `gsi2pk/gsi2sk`), SQS batch/finalize queues + DLQs.
3. Add SQS → Lambda event source mappings (batch size 1, report batch item failures). Set reserved concurrency ≤ global limit.
4. Run the API with `AUTO_PROVISION=false`, real endpoint, IAM roles. Set `S3_PUBLIC_ENDPOINT` empty.
5. Verify the SES identity/domain; move out of the sandbox for arbitrary recipients.

## TODO / status

Legend: `[ ]` pending · `[x]` done

### Foundation
- [x] Root npm workspaces, scripts, env template, gitignore
- [x] Docker compose (LocalStack, Redis, API, PDF/ZIP workers, portal)
- [x] PLAN.md and README.md

### Go pipeline
- [x] Shared config, domain, cache keys, Dynamo/S3 store, order snapshots
- [x] PDF renderer (supplier item tables, totals, revision footer)
- [x] PDF worker (cache HEAD, render, counters, batch completion, finalise publish)
- [x] ZIP finaliser (freshness check, supplier folders, manifest, presigned URL, SES)
- [x] Lambda entrypoints + local `devrunner` with bounded concurrency
- [x] Go tests (cache key, supplier grouping, slug safety, ZIP TTL, PDF output)

### NestJS API
- [x] AWS clients + LocalStack auto-provisioning (bucket, lifecycle, table, queues, SES, catalog)
- [x] Jobs service (validate, batch, filter hash, Dynamo items, GSI listing)
- [x] Redis Lua admission limiter + scheduler reconciliation
- [x] SSE snapshots with limits and queue positions
- [x] Order mutate, ZIP download, email preview, retry, health endpoints
- [x] API type-check + production build

### React portal
- [x] Order browser with search/supplier/status filters and multi-select
- [x] Client switcher, limits/queue banner
- [x] Live job cards via SSE (polling fallback), batch detail
- [x] Download ZIP, email preview, cache stats, supplier folders
- [x] Cache-busting action and notifications
- [x] Portal production build

### Verification
- [x] Full local stack boots and provisions resources (Docker Compose, this machine)
- [x] End-to-end job completes with PDFs, ZIP, SES copy
- [x] Identical rerun shows PDF + ZIP cache hits
- [x] Mutated order invalidates cache and regenerates content
- [x] Per-client/global concurrency limits hold under burst (observed 2 / 10)
- [x] `scripts/smoke.mjs` passes (26/26)
- [x] Live AWS deployment verified via raw Elastic IP and Cloudflare Tunnel (`https://pdf-lambda-demo.xxmrphdxx.my`)
- [x] README quick start verified on this machine (`http://localhost:8080`)

## Known limitations

- LocalStack SES only stores emails for this demo (we persist copies to S3); real delivery requires verified identities in AWS.
- `AUTO_PROVISION` is a demo convenience, not production IaC.
- Catalog mutations use last-write-wins (no optimistic concurrency). A job pins its order snapshot at submission, so edits affect new jobs only.
- Documents are cached by content, but per-document progress counters are best-effort under SQS redelivery; the batch's final `docs` list (and therefore the ZIP) is authoritative.
- SSE polls DynamoDB (700 ms) rather than pushing from workers; simple and good enough for a demo.
- ZIPs are built in `/tmp` and capped implicitly by demo sizes.
- Presigned URLs use `S3_PUBLIC_ENDPOINT`, which must be reachable by the browser. For a remote host, set it to that host's LocalStack URL (or a real S3 endpoint in AWS).
