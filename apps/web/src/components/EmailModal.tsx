import { useEffect, useState } from "react";
import type { JobDto, StoredEmail } from "../types";
import { downloadUrl } from "../api";
import { formatDate } from "../utils";

export function EmailModal({
  job,
  email,
  onClose,
}: {
  job: JobDto;
  email: StoredEmail;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"rendered" | "text">("rendered");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal email-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="email-subject"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <div className="eyebrow">SES / captured message</div>
            <h2 id="email-subject">{email.subject}</h2>
            <div className="modal-meta">
              <span>
                <em>From</em> {email.from}
              </span>
              <span>
                <em>To</em> {email.to}
              </span>
              {email.sentAt && (
                <span>
                  <em>Sent</em> {formatDate(email.sentAt)}
                </span>
              )}
            </div>
          </div>
          <button type="button" className="icon-button close-button" onClick={onClose} aria-label="Close email preview">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        </header>

        {email.error && <div className="modal-warning">SES error: {email.error}</div>}

        <div className="tabs">
          <button
            type="button"
            className={tab === "rendered" ? "active" : ""}
            onClick={() => setTab("rendered")}
          >
            Rendered
          </button>
          <button
            type="button"
            className={tab === "text" ? "active" : ""}
            onClick={() => setTab("text")}
          >
            Plain text
          </button>
        </div>

        <div className="email-preview">
          {tab === "rendered" ? (
            <iframe title="Email preview" sandbox="" srcDoc={email.html} />
          ) : (
            <pre>{email.text}</pre>
          )}
        </div>

        <footer className="modal-foot">
          <span className="modal-hint">
            ZIP link is presigned ({email.zipCached ? "cached" : "fresh"} archive). In LocalStack the copy is
            stored at <code>emails/{job.jobId}.json</code> for preview.
          </span>
          <div className="modal-actions">
            <button type="button" className="ghost-button" onClick={onClose}>
              Close
            </button>
            <a
              className="primary-button small"
              href={downloadUrl(job.jobId)}
              target="_blank"
              rel="noreferrer"
            >
              Download ZIP
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
