import type { BatchDto, JobDetail, JobDto, Limits } from "../types";
import { downloadUrl } from "../api";
import {
  formatBytes,
  formatDate,
  percent,
  shortJobId,
  timeAgo,
} from "../utils";
import { SlotMeter } from "./SlotMeter";
import { StatusBadge } from "./StatusBadge";

interface Props {
  jobs: JobDto[];
  limits: Limits;
  live: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  expandedId?: string;
  detail?: JobDetail;
  detailLoading: boolean;
  onToggleExpand: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  retryingId?: string;
  onEmail: (job: JobDto) => void;
  emailLoadingId?: string;
}

export function JobsPanel({
  jobs,
  limits,
  live,
  refreshing,
  onRefresh,
  expandedId,
  detail,
  detailLoading,
  onToggleExpand,
  onRetry,
  retryingId,
  onEmail,
  emailLoadingId,
}: Props) {
  const cachedDocs = jobs.reduce((sum, job) => sum + job.pdfsCached, 0);
  const doneDocs = jobs.reduce((sum, job) => sum + job.pdfsDone, 0);
  const cacheRate = doneDocs > 0 ? Math.round((cachedDocs / doneDocs) * 100) : 0;

  return (
    <section className="panel queue-panel">
      <div className="panel-heading queue-heading">
        <div>
          <div className="eyebrow">02 / Pipeline</div>
          <h2>Live queue</h2>
          <p className="panel-sub">
            SSE snapshots every 700 ms · {jobs.length} recent job{jobs.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="queue-tools">
          <span className={`live-chip ${live ? "live" : "polling"}`}>
            <span className="live-dot" />
            {live ? "Live" : "Polling"}
          </span>
          <button
            type="button"
            className={`icon-button ${refreshing ? "busy" : ""}`}
            onClick={onRefresh}
            title="Refresh now"
            aria-label="Refresh jobs"
            disabled={refreshing}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M15.4 7.2a6 6 0 1 0 .4 4.3" />
              <path d="M15.5 3v4.5H11" />
            </svg>
          </button>
        </div>
      </div>

      <div className="queue-limits">
        <div className="limit-block">
          <span className="limit-label">Global slots</span>
          <SlotMeter running={limits.globalRunning} limit={limits.globalLimit} label="Global slots" />
        </div>
        <div className="limit-divider" />
        <div className="limit-block">
          <span className="limit-label">This client</span>
          <SlotMeter running={limits.clientRunning} limit={limits.clientLimit} label="Client slots" />
        </div>
        <div className="limit-divider" />
        <div className="limit-block compact">
          <span className="limit-label">Waiting</span>
          <strong className="limit-number">{limits.queuedJobs}</strong>
        </div>
        <div className="limit-block compact">
          <span className="limit-label">Cache hit</span>
          <strong className="limit-number">{cacheRate}%</strong>
        </div>
      </div>

      <div className="job-list">
        {jobs.length === 0 && (
          <div className="empty-state">
            <div className="empty-art" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <h3>No jobs yet</h3>
            <p>Select some orders on the left and generate a pack. Progress shows up here in real time.</p>
          </div>
        )}
        {jobs.map((job) => {
          const expanded = expandedId === job.jobId;
          const batchTicks = Array.from({ length: Math.max(1, job.batchCount) });
          return (
            <article key={job.jobId} className={`job-card job-${job.status.toLowerCase()}`}>
              <header className="job-head">
                <div className="job-head-left">
                  <StatusBadge status={job.status} />
                  <span className="job-id" title={job.jobId}>
                    {shortJobId(job.jobId)}
                  </span>
                  <span className="job-client">{job.clientName}</span>
                </div>
                <time className="job-time" title={formatDate(job.createdAt)}>
                  {timeAgo(job.createdAt)}
                </time>
              </header>

              <div className="job-title-row">
                <div>
                  <h3>
                    {job.orderCount} orders · {job.pdfsTotal} PDFs
                  </h3>
                  <div className="job-message">{jobMessage(job)}</div>
                </div>
                <div className="job-percent">
                  <strong>{job.percent}</strong>
                  <span>%</span>
                </div>
              </div>

              <div className={`progress-track ${job.status === "FINALIZING" ? "pulse" : ""}`}>
                <span style={{ width: `${job.percent}%` }} />
              </div>

              <div className="batch-ticks" aria-hidden="true">
                {batchTicks.map((_, index) => (
                  <span
                    key={index}
                    className={`batch-tick ${index < job.batchesDone ? "done" : ""} ${
                      job.status === "RUNNING" && index === job.batchesDone ? "active" : ""
                    }`}
                  />
                ))}
              </div>

              <div className="job-stats">
                <div>
                  <span>PDFs</span>
                  <strong>
                    {job.pdfsDone}
                    <small>/{job.pdfsTotal}</small>
                  </strong>
                </div>
                <div>
                  <span>Cache hits</span>
                  <strong>{job.pdfsCached}</strong>
                </div>
                <div>
                  <span>Generated</span>
                  <strong>{job.pdfsGenerated}</strong>
                </div>
                <div>
                  <span>Batches</span>
                  <strong>
                    {job.batchesDone}
                    <small>/{job.batchCount}</small>
                  </strong>
                </div>
              </div>

              {job.status === "QUEUED" && (
                <div className="job-note queued-note">
                  <span className="note-icon">⏳</span>
                  <span>
                    {job.queuePosition
                      ? `Position #${job.queuePosition} in queue`
                      : "Waiting for a free slot"}{" "}
                    · limits are 2 per client / 10 globally.
                  </span>
                </div>
              )}
              {job.status === "RUNNING" && (
                <div className="job-note running-note">
                  <span className="note-icon">⚙</span>
                  <span>Rendering batch {Math.min(job.batchesDone + 1, job.batchCount)} of {job.batchCount} across Go lambdas.</span>
                </div>
              )}
              {job.status === "FINALIZING" && (
                <div className="job-note finalizing-note">
                  <span className="note-icon">🗜</span>
                  <span>Building the supplier-grouped ZIP, then sending the SES email.</span>
                </div>
              )}
              {job.status === "FAILED" && (
                <div className="job-note failed-note">
                  <span className="note-icon">!</span>
                  <span>{job.error || "The pipeline failed. Check the worker logs."}</span>
                </div>
              )}

              {job.status === "COMPLETED" && (
                <div className="completion">
                  <div className="completion-meta">
                    <span className="completion-size">{formatBytes(job.zipBytes)} ZIP</span>
                    <span className={`cache-pill ${job.zipCached ? "hit" : "fresh"}`}>
                      {job.zipCached ? "ZIP cache hit" : "Fresh ZIP"}
                    </span>
                    <span className="completion-email">to {job.email}</span>
                    {job.emailError && <span className="email-error">Email failed</span>}
                  </div>
                  {job.supplierCounts && Object.keys(job.supplierCounts).length > 0 && (
                    <div className="supplier-chips">
                      {Object.entries(job.supplierCounts)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([supplier, count]) => (
                          <span key={supplier} className="supplier-chip">
                            <span className="folder">▸</span>
                            {supplier}
                            <em>{count}</em>
                          </span>
                        ))}
                    </div>
                  )}
                  <div className="job-actions">
                    <a
                      className="primary-button small"
                      href={downloadUrl(job.jobId)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Download ZIP
                      <svg viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M4 16h12" />
                      </svg>
                    </a>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => onEmail(job)}
                      disabled={emailLoadingId === job.jobId}
                    >
                      {emailLoadingId === job.jobId ? "Loading..." : "View email"}
                    </button>
                  </div>
                </div>
              )}

              <footer className="job-footer">
                <button
                  type="button"
                  className={`detail-toggle ${expanded ? "open" : ""}`}
                  onClick={() => onToggleExpand(job.jobId)}
                  aria-expanded={expanded}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="m5 7 5 5 5-5" />
                  </svg>
                  {expanded ? "Hide batches" : "Batch detail"}
                </button>
                <div className="job-footer-right">
                  {job.status === "FAILED" && (
                    <button
                      type="button"
                      className="ghost-button danger"
                      onClick={() => onRetry(job.jobId)}
                      disabled={retryingId === job.jobId}
                    >
                      {retryingId === job.jobId ? "Requeueing..." : "Retry job"}
                    </button>
                  )}
                  <span className="job-stamp">
                    {job.finishedAt ? `finished ${timeAgo(job.finishedAt)}` : `queued ${timeAgo(job.createdAt)}`}
                  </span>
                </div>
              </footer>

              {expanded && (
                <div className="batch-detail">
                  {detailLoading && !detail ? (
                    <div className="detail-loading">Loading batches...</div>
                  ) : detail ? (
                    detail.batches.map((batch) => <BatchRow key={batch.index} batch={batch} />)
                  ) : (
                    <div className="detail-loading">No batch detail available.</div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function BatchRow({ batch }: { batch: BatchDto }) {
  const pct = percent(batch.pdfsDone, batch.pdfsTotal);
  return (
    <div className={`batch-row batch-${batch.status.toLowerCase()}`}>
      <div className="batch-index">#{String(batch.index + 1).padStart(2, "0")}</div>
      <div className="batch-main">
        <div className="batch-top">
          <span className={`batch-status batch-status-${batch.status.toLowerCase()}`}>
            {batch.status.toLowerCase()}
          </span>
          <span className="batch-orders">{batch.orderCount} orders</span>
          <span className="batch-docs">
            {batch.pdfsDone}/{batch.pdfsTotal} PDFs
          </span>
          <span className="batch-cache">{batch.pdfsCached} cached</span>
        </div>
        <div className="mini-progress">
          <span style={{ width: `${batch.status === "DONE" ? 100 : pct}%` }} />
        </div>
        {batch.error && <div className="batch-error">{batch.error}</div>}
      </div>
      <div className="batch-percent">{batch.status === "DONE" ? "100%" : `${pct}%`}</div>
    </div>
  );
}

function jobMessage(job: JobDto): string {
  switch (job.status) {
    case "QUEUED":
      return "Waiting for admission";
    case "RUNNING":
      return "Rendering PDFs and filling the S3 cache";
    case "FINALIZING":
      return "Zipping supplier folders";
    case "COMPLETED":
      return job.zipCached
        ? "Reused the cached archive for this exact selection"
        : "Archive built once and cached for repeated downloads";
    case "FAILED":
      return "Needs attention";
  }
}
