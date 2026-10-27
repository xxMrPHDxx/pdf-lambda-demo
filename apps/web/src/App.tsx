import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { EmailModal } from "./components/EmailModal";
import { JobsPanel } from "./components/JobsPanel";
import { OrderBrowser } from "./components/OrderBrowser";
import { SlotMeter } from "./components/SlotMeter";
import { Toasts, type ToastItem } from "./components/Toasts";
import type {
  BootstrapResponse,
  HealthResponse,
  JobDetail,
  JobDto,
  Order,
  Snapshot,
  StoredEmail,
} from "./types";
import { shortJobId } from "./utils";

export default function App() {
  const [clientId, setClientId] = useState("acme");
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [email, setEmail] = useState("ops@acme.test");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [mutatingId, setMutatingId] = useState<string>();
  const [retryingId, setRetryingId] = useState<string>();
  const [emailLoadingId, setEmailLoadingId] = useState<string>();
  const [emailModal, setEmailModal] = useState<{ job: JobDto; email: StoredEmail } | null>(null);
  const [expandedId, setExpandedId] = useState<string>();
  const [detail, setDetail] = useState<JobDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [live, setLive] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const pushToast = useCallback((text: string, kind: ToastItem["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items, { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
    }, 5500);
  }, []);

  const refreshSnapshot = useCallback(async () => {
    try {
      const next = await api.snapshot(clientId);
      setSnapshot(next);
      return next;
    } catch {
      return null;
    }
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSelected(new Set());
    setExpandedId(undefined);
    setDetail(undefined);

    api
      .bootstrap(clientId)
      .then((data) => {
        if (cancelled) return;
        setBootstrap(data);
        setSnapshot({ jobs: data.jobs, limits: data.limits, serverTime: data.serverTime });
        const client = data.clients.find((entry) => entry.id === clientId);
        if (client) {
          setEmail(client.email);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setLoadError(error.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [clientId, reloadKey]);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const result = await api.health();
        if (!stopped) setHealth(result);
      } catch {
        if (!stopped) setHealth(null);
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 15000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [reloadKey]);

  useEffect(() => {
    let stopped = false;
    let localLive = false;
    const source = new EventSource(`/api/events?clientId=${encodeURIComponent(clientId)}`);

    const onSnapshot = (event: MessageEvent<string>) => {
      if (stopped) return;
      try {
        const data = JSON.parse(event.data) as Snapshot;
        localLive = true;
        setLive(true);
        setSnapshot(data);
      } catch {
        // Ignore malformed frames; the next tick will recover.
      }
    };

    source.addEventListener("snapshot", onSnapshot as EventListener);
    source.addEventListener("problem", (event) => {
      const detail = (event as MessageEvent<string>).data;
      if (detail) {
        console.warn("SSE problem", detail);
      }
    });
    source.onopen = () => {
      if (!stopped) {
        localLive = true;
        setLive(true);
      }
    };
    source.onerror = () => {
      if (!stopped) {
        localLive = false;
        setLive(false);
      }
    };

    const poll = window.setInterval(() => {
      if (stopped || localLive) return;
      void api
        .snapshot(clientId)
        .then((data) => {
          if (!stopped) setSnapshot(data);
        })
        .catch(() => undefined);
    }, 2500);

    return () => {
      stopped = true;
      source.close();
      window.clearInterval(poll);
    };
  }, [clientId]);

  const expandedJob = snapshot?.jobs.find((job) => job.jobId === expandedId);

  useEffect(() => {
    if (!expandedId) {
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    api
      .jobDetail(expandedId)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expandedId, expandedJob?.pdfsDone, expandedJob?.batchesDone, expandedJob?.status]);

  const handleCreate = async () => {
    if (!bootstrap || selected.size === 0) return;
    setSubmitting(true);
    try {
      const result = await api.createJob({
        clientId,
        orderIds: [...selected],
        email,
      });
      pushToast(
        `Job ${shortJobId(result.job.jobId)} queued — ${result.job.orderCount} orders / ${result.job.pdfsTotal} PDFs.`,
        "success",
      );
      setSelected(new Set());
      await refreshSnapshot();
    } catch (error) {
      pushToast((error as Error).message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleMutate = async (order: Order) => {
    setMutatingId(order.id);
    try {
      const result = await api.mutateOrder(order.id);
      setBootstrap((current) =>
        current
          ? {
              ...current,
              orders: current.orders.map((order) =>
                order.id === result.order.id ? result.order : order,
              ),
              catalogVersion: current.catalogVersion + 1,
              catalogUpdatedAt: new Date().toISOString(),
            }
          : current,
      );
      pushToast(result.message, "success");
    } catch (error) {
      pushToast((error as Error).message, "error");
    } finally {
      setMutatingId(undefined);
    }
  };

  const handleRetry = async (jobId: string) => {
    setRetryingId(jobId);
    try {
      const result = await api.retry(jobId);
      pushToast(`Requeued as ${shortJobId(result.job.jobId)}.`, "success");
      await refreshSnapshot();
    } catch (error) {
      pushToast((error as Error).message, "error");
    } finally {
      setRetryingId(undefined);
    }
  };

  const handleEmail = async (job: JobDto) => {
    setEmailLoadingId(job.jobId);
    try {
      const payload = await api.email(job.jobId);
      setEmailModal({ job, email: payload });
    } catch (error) {
      pushToast((error as Error).message, "error");
    } finally {
      setEmailLoadingId(undefined);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshSnapshot();
    window.setTimeout(() => setRefreshing(false), 350);
  };

  const toggleExpand = (jobId: string) => {
    if (expandedId === jobId) {
      setExpandedId(undefined);
      setDetail(undefined);
    } else {
      setExpandedId(jobId);
      setDetail(undefined);
    }
  };

  const limits = snapshot?.limits ?? {
    globalRunning: 0,
    globalLimit: 10,
    clientRunning: 0,
    clientLimit: 2,
    queuedJobs: 0,
  };
  const jobs = snapshot?.jobs ?? [];
  const cachedDocs = jobs.reduce((sum, job) => sum + job.pdfsCached, 0);
  const doneDocs = jobs.reduce((sum, job) => sum + job.pdfsDone, 0);
  const cacheRate = doneDocs > 0 ? Math.round((cachedDocs / doneDocs) * 100) : 0;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="brand-copy">
            <div className="brand-name">PaperTrail</div>
            <div className="brand-sub">PDF fulfilment pipeline</div>
          </div>
        </div>
        <div className="header-mid">
          <span className="service-chip">
            <i className={health?.checks.s3 === "ok" ? "on" : ""} /> S3 cache
          </span>
          <span className="service-chip">
            <i className={health?.checks.sqs === "ok" ? "on" : ""} /> SQS fan-out
          </span>
          <span className="service-chip">
            <i className={health?.checks.dynamodb === "ok" ? "on" : ""} /> DynamoDB
          </span>
          <span className="service-chip">
            <i className={health ? "on" : ""} /> Go lambdas
          </span>
          <span className="service-chip">
            <i className={health?.checks.redis === "ok" ? "on" : ""} /> Redis slots
          </span>
        </div>
        <div className={`header-live ${live ? "live" : "polling"}`}>
          <span className="live-dot" />
          <div>
            <strong>{live ? "Streaming" : "Fallback poll"}</strong>
            <span>{live ? "SSE / 700ms" : "HTTP / 2.5s"}</span>
          </div>
        </div>
      </header>

      <main className="app-main">
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">Async order packs · LocalStack runtime</div>
            <h1>
              Supplier-ready PDFs,
              <br />
              <em>without the wait.</em>
            </h1>
            <p>
              Select orders and fan them out into SQS batches. Go lambdas render each document into
              an S3 cache, then a finaliser assembles supplier folders into a ZIP and sends a
              presigned link over SES.
            </p>
            <div className="hero-notes">
              <span>PDF cache keyed by rev + status + item hash</span>
              <span>ZIP reused for a few hours</span>
              <span>
                {limits.clientLimit} jobs per client · {limits.globalLimit} global
              </span>
            </div>
          </div>

          <div className="hero-stats">
            <div className="stat-card">
              <span className="stat-label">Running now</span>
              <div className="stat-value">
                {limits.globalRunning}
                <small>/{limits.globalLimit}</small>
              </div>
              <SlotMeter running={limits.globalRunning} limit={limits.globalLimit} label="Global slots" />
            </div>
            <div className="stat-card">
              <span className="stat-label">This client</span>
              <div className="stat-value">
                {limits.clientRunning}
                <small>/{limits.clientLimit}</small>
              </div>
              <SlotMeter running={limits.clientRunning} limit={limits.clientLimit} label="Client slots" />
            </div>
            <div className="stat-card">
              <span className="stat-label">Waiting</span>
              <div className="stat-value">{limits.queuedJobs}</div>
              <span className="stat-foot">jobs in the admission queue</span>
            </div>
            <div className="stat-card accent">
              <span className="stat-label">Cache hit rate</span>
              <div className="stat-value">{cacheRate}<small>%</small></div>
              <span className="stat-foot">
                {cachedDocs} cached / {doneDocs} rendered
              </span>
            </div>
          </div>
        </section>

        {loadError && !bootstrap && (
          <div className="error-banner">
            <div>
              <strong>API unreachable.</strong> {loadError}
              <span>Start LocalStack + Redis, then retry. The API provisions S3, SQS, SES and DynamoDB on boot.</span>
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setLoadError(null);
                setReloadKey((key) => key + 1);
              }}
            >
              Retry
            </button>
          </div>
        )}

        {loading && !bootstrap ? (
          <div className="loading-grid">
            <div className="skeleton skeleton-left" />
            <div className="skeleton skeleton-right" />
          </div>
        ) : bootstrap ? (
          <div className="workspace">
            <OrderBrowser
              key={clientId}
              clients={bootstrap.clients}
              clientId={clientId}
              onClientChange={setClientId}
              orders={bootstrap.orders}
              suppliers={bootstrap.suppliers}
              email={email}
              onEmailChange={setEmail}
              selected={selected}
              onSelectedChange={setSelected}
              submitting={submitting}
              onCreate={handleCreate}
              onMutate={handleMutate}
              mutatingId={mutatingId}
            />
            <JobsPanel
              jobs={jobs}
              limits={limits}
              live={live}
              refreshing={refreshing}
              onRefresh={handleRefresh}
              expandedId={expandedId}
              detail={detail}
              detailLoading={detailLoading}
              onToggleExpand={toggleExpand}
              onRetry={handleRetry}
              retryingId={retryingId}
              onEmail={handleEmail}
              emailLoadingId={emailLoadingId}
            />
          </div>
        ) : null}

        <footer className="app-footer">
          <div>
            <strong>PaperTrail demo</strong> · React · NestJS · Go lambdas · SQS · S3 · SES · DynamoDB ·
            LocalStack
          </div>
          <div className="footer-right">
            <span>catalog v{bootstrap?.catalogVersion ?? "-"}</span>
            <span>batches of {health?.limits.batchSize ?? 4} orders</span>
            <span>{health ? `runtime ${health.status}` : "runtime offline"}</span>
          </div>
        </footer>
      </main>

      {emailModal && (
        <EmailModal
          job={emailModal.job}
          email={emailModal.email}
          onClose={() => setEmailModal(null)}
        />
      )}
      <Toasts items={toasts} onDismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))} />
    </div>
  );
}
