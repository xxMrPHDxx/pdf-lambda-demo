#!/usr/bin/env node
/**
 * End-to-end smoke test for the local stack.
 *
 * Prereqs: docker compose up -d localstack redis, API on :3000, both workers running.
 * Run: node scripts/smoke.mjs
 */

const API = process.env.API_URL || "http://localhost:3000";
const JOB_TIMEOUT_MS = Number(process.env.SMOKE_JOB_TIMEOUT_MS || 240_000);

const results = [];
let failures = 0;

function ok(message) {
  results.push({ ok: true, message });
  console.log(`  \u2713 ${message}`);
}

function fail(message) {
  results.push({ ok: false, message });
  failures++;
  console.error(`  \u2717 ${message}`);
}

function assert(condition, message) {
  if (condition) ok(message);
  else fail(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API}${path}`, { ...options, headers });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (payload.message) message = Array.isArray(payload.message) ? payload.message.join(", ") : payload.message;
    } catch {
      // Non-JSON error body.
    }
    throw new Error(`${path}: ${message}`);
  }
  return response;
}

async function json(path, options) {
  return (await request(path, options)).json();
}

async function waitForHealth() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const health = await json("/api/health");
      if (health.status === "ok" || health.status === "degraded") {
        ok(`API healthy (${health.status})`);
        return health;
      }
    } catch {
      // API still booting.
    }
    await sleep(1500);
  }
  throw new Error("API did not become healthy within 90s");
}

async function waitForJob(jobId, label = jobId, timeout = JOB_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    const detail = await json(`/api/jobs/${encodeURIComponent(jobId)}`);
    last = detail.job;
    if (last.status === "COMPLETED" || last.status === "FAILED") {
      return detail;
    }
    await sleep(400);
  }
  throw new Error(`Job ${label} did not finish: ${last?.status} ${last?.error ?? ""}`);
}

async function createJob(clientId, orderIds, email) {
  const { job } = await json("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ clientId, orderIds, email }),
  });
  return job;
}

async function fetchZip(jobId) {
  const response = await request(`/api/jobs/${encodeURIComponent(jobId)}/download`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer;
}

async function main() {
  console.log("\nPaperTrail smoke test");
  console.log(`API: ${API}\n`);

  await waitForHealth();

  const bootstrap = await json("/api/bootstrap?clientId=acme");
  assert(bootstrap.orders.length >= 6, `catalog has ${bootstrap.orders.length} acme orders`);
  assert(bootstrap.clients.length >= 3, `catalog has ${bootstrap.clients.length} clients`);

  const selection = bootstrap.orders.slice(0, 6);
  const orderIds = selection.map((order) => order.id);
  const expectedDocs = selection.reduce(
    (sum, order) => sum + new Set(order.items.map((item) => item.supplier)).size,
    0,
  );
  const email = process.env.SMOKE_EMAIL || "smoke@acme.test";

  console.log("\n[1] Cold run: PDFs, ZIP, SES");
  const first = await createJob("acme", orderIds, email);
  const firstDetail = await waitForJob(first.jobId, "cold run");
  assert(firstDetail.job.status === "COMPLETED", `job completed (${firstDetail.job.status})`);
  assert(firstDetail.job.pdfsDone === expectedDocs, `all ${expectedDocs} PDFs present`);
  assert(firstDetail.job.batchesDone === firstDetail.job.batchCount, "all batches finished");
  assert(firstDetail.job.zipBytes > 1000, `ZIP has ${firstDetail.job.zipBytes} bytes`);
  assert(typeof firstDetail.job.emailMessageId === "string" && firstDetail.job.emailMessageId.length > 0, "SES returned a message id");
  assert(!firstDetail.job.emailError, `no SES error (${firstDetail.job.emailError || "none"})`);

  const zip = await fetchZip(first.jobId);
  assert(zip.subarray(0, 2).toString() === "PK", "download starts with ZIP magic bytes");
  const zipText = zip.toString("utf8");
  assert(zipText.includes("manifest.json"), "ZIP contains manifest.json");
  const suppliers = new Set(selection.flatMap((order) => order.items.map((item) => item.supplier)));
  assert(
    [...suppliers].every((supplier) => zipText.includes(`${supplier}/`)),
    `ZIP has supplier folders (${[...suppliers].join(", ")})`,
  );

  const emailRecord = await json(`/api/jobs/${encodeURIComponent(first.jobId)}/email`);
  assert(emailRecord.to === email, `email addressed to ${email}`);
  assert(emailRecord.subject.includes(`${expectedDocs} documents`), "email subject mentions document count");
  assert(
    typeof emailRecord.downloadUrl === "string" && emailRecord.downloadUrl.includes("X-Amz-Signature"),
    "email contains a presigned S3 link",
  );
  if (emailRecord.downloadUrl) {
    const linked = await fetch(emailRecord.downloadUrl);
    const linkedBytes = Buffer.from(await linked.arrayBuffer());
    assert(
      linked.ok && linkedBytes.length > 1000 && linkedBytes.subarray(0, 2).toString() === "PK",
      "presigned email link downloads the ZIP",
    );
  }

  console.log("\n[2] Identical rerun: PDF + ZIP cache");
  const second = await createJob("acme", orderIds, email);
  const secondDetail = await waitForJob(second.jobId, "cache rerun");
  assert(secondDetail.job.pdfsCached === expectedDocs, `all ${expectedDocs} PDFs served from S3 cache`);
  assert(secondDetail.job.pdfsGenerated === 0, "no PDFs re-rendered");
  assert(secondDetail.job.zipCached === true, "ZIP reused from cache");

  console.log("\n[3] External edit: cache invalidation");
  const mutation = await json(`/api/orders/${encodeURIComponent(orderIds[0])}/mutate`, {
    method: "POST",
    body: JSON.stringify({ bumpRev: true, qtyDelta: 2 }),
  });
  assert(mutation.order.rev > selection[0].rev, `order rev bumped to ${mutation.order.rev}`);
  const third = await createJob("acme", orderIds, email);
  const thirdDetail = await waitForJob(third.jobId, "mutation rerun");
  assert(thirdDetail.job.pdfsGenerated >= 1, `${thirdDetail.job.pdfsGenerated} PDF(s) regenerated after edit`);
  assert(thirdDetail.job.zipCached === false, "ZIP rebuilt for the new selection hash");

  console.log("\n[4] Admission limits under burst");
  const clients = bootstrap.clients.slice(0, 6);
  const submitted = new Map();
  const burstJobs = [];
  for (const client of clients) {
    const clientBootstrap = await json(`/api/bootstrap?clientId=${encodeURIComponent(client.id)}`);
    const ids = clientBootstrap.orders.map((order) => order.id);
    if (ids.length === 0) continue;
    const copies = client.id === "acme" ? 3 : 2;
    for (let i = 0; i < copies; i++) {
      const job = await createJob(client.id, ids, client.email);
      burstJobs.push(job.jobId);
      submitted.set(job.jobId, client.id);
    }
  }
  assert(burstJobs.length >= 5, `submitted ${burstJobs.length} jobs across ${clients.length} clients`);

  const terminal = new Set(["COMPLETED", "FAILED"]);
  const clientsInBurst = [...new Set(submitted.values())];
  let maxGlobal = 0;
  let maxClient = 0;
  let allDone = false;
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let done = 0;
    for (const clientId of clientsInBurst) {
      const snapshot = await json(`/api/jobs?clientId=${encodeURIComponent(clientId)}`);
      maxGlobal = Math.max(maxGlobal, snapshot.limits.globalRunning);
      maxClient = Math.max(maxClient, snapshot.limits.clientRunning);
      for (const jobId of burstJobs) {
        if (submitted.get(jobId) !== clientId) continue;
        const job = snapshot.jobs.find((entry) => entry.jobId === jobId);
        if (job && terminal.has(job.status)) done++;
      }
    }
    if (done === burstJobs.length) {
      allDone = true;
      break;
    }
    await sleep(300);
  }
  assert(allDone, "all burst jobs reached a terminal state");
  assert(maxGlobal <= 10, `global running never exceeded 10 (observed ${maxGlobal})`);
  assert(maxClient <= 2, `per-client running never exceeded 2 (observed ${maxClient})`);

  console.log("\nSummary");
  console.log(`  passed: ${results.filter((entry) => entry.ok).length}`);
  console.log(`  failed: ${failures}`);
  if (failures > 0) {
    process.exitCode = 1;
  } else {
    console.log("\nSmoke test passed.\n");
  }
}

main().catch((error) => {
  console.error(`\nSmoke test crashed: ${error.message}\n`);
  process.exitCode = 1;
});
