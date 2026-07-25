import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { JobDetail } from "../api/client";

export type LiveProgress = {
  bytesDone?: number;
  bytesTotal?: number | null;
  progressPct?: number;
  status?: string;
  phase?: string;
  resumedFrom?: number;
  speedBps?: number;
  updatedAt: number;
};

/**
 * Live job progress via SSE + fast polling fallback.
 * SSE payloads are merged into the React Query cache immediately so the UI
 * does not sit at 0% until a full refetch completes.
 */
export function useJobEvents(jobId: string | undefined): {
  live: LiveProgress | null;
  sseConnected: boolean;
} {
  const qc = useQueryClient();
  const [live, setLive] = useState<LiveProgress | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const lastBytesRef = useRef<{ t: number; bytes: number } | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let es: EventSource | null = null;
    let closed = false;
    let retryTimer: number | undefined;
    let pollTimer: number | undefined;

    const mergeProgress = ( partial: Record<string, unknown>) => {
      const now = Date.now();
      const bytesDone =
        typeof partial.bytesDone === "number"
          ? partial.bytesDone
          : undefined;
      const bytesTotal =
        typeof partial.bytesTotal === "number"
          ? partial.bytesTotal
          : partial.bytesTotal === null
            ? null
            : undefined;

      let speedBps: number | undefined;
      if (bytesDone != null) {
        const prev = lastBytesRef.current;
        if (prev && now > prev.t) {
          const dt = (now - prev.t) / 1000;
          if (dt > 0.2) {
            speedBps = Math.max(0, (bytesDone - prev.bytes) / dt);
          }
        }
        lastBytesRef.current = { t: now, bytes: bytesDone };
      }

      let progressPct: number | undefined =
        typeof partial.progressPct === "number"
          ? partial.progressPct
          : undefined;
      if (
        progressPct == null &&
        bytesDone != null &&
        bytesTotal != null &&
        bytesTotal > 0
      ) {
        progressPct = Math.min(100, Math.round((bytesDone / bytesTotal) * 100));
      }

      const next: LiveProgress = {
        bytesDone,
        bytesTotal,
        progressPct,
        status:
          typeof partial.status === "string" ? partial.status : undefined,
        phase: typeof partial.phase === "string" ? partial.phase : undefined,
        resumedFrom:
          typeof partial.resumedFrom === "number"
            ? partial.resumedFrom
            : undefined,
        speedBps,
        updatedAt: now,
      };

      setLive((prev) => ({
        ...prev,
        ...Object.fromEntries(
          Object.entries(next).filter(([, v]) => v !== undefined),
        ),
        updatedAt: now,
      }));

      // Patch cached job detail so Progress re-renders without waiting for network
      qc.setQueryData<JobDetail>(["job", jobId], (old) => {
        if (!old) return old;
        const patched = { ...old };
        if (bytesDone != null) patched.bytesDone = bytesDone;
        if (bytesTotal !== undefined) {
          patched.bytesTotal = bytesTotal;
        }
        if (progressPct != null) patched.progressPct = progressPct;
        if (typeof partial.status === "string") {
          patched.status = partial.status;
        }
        if (typeof partial.checksumSha256 === "string") {
          patched.checksumSha256 = partial.checksumSha256;
        }
        if (typeof partial.fileName === "string") {
          patched.fileName = partial.fileName;
        }
        if (typeof partial.artifactId === "string") {
          (patched as { artifactId?: string }).artifactId = partial.artifactId;
        }
        // recompute pct if we have totals
        if (
          patched.bytesTotal &&
          patched.bytesTotal > 0 &&
          patched.bytesDone != null
        ) {
          patched.progressPct = Math.min(
            100,
            Math.round((patched.bytesDone / patched.bytesTotal) * 100),
          );
        }
        return patched;
      });
    };

    const hardRefresh = () => {
      void qc.invalidateQueries({ queryKey: ["job", jobId] });
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["artifacts"] });
    };

    const connect = () => {
      if (closed) return;
      es = new EventSource(`/api/v1/jobs/${jobId}/events`, {
        withCredentials: true,
      });

      es.onopen = () => setSseConnected(true);

      const onEvent = (ev: MessageEvent) => {
        try {
          const data = JSON.parse(String(ev.data)) as Record<string, unknown>;
          // Full job snapshot from first event or finished
          if (data && typeof data === "object") {
            mergeProgress(data);
            // nested targets progress
            if (Array.isArray(data.targets)) {
              qc.setQueryData<JobDetail>(["job", jobId], (old) => {
                if (!old) return old;
                return {
                  ...old,
                  ...data,
                  targets: data.targets as JobDetail["targets"],
                  steps: (data.steps as JobDetail["steps"]) ?? old.steps,
                } as JobDetail;
              });
            }
          }
        } catch {
          /* ignore malformed */
        }
        // Also schedule a full refetch for steps/targets consistency
        hardRefresh();
      };

      for (const name of [
        "job.updated",
        "step.updated",
        "target.updated",
        "job.finished",
      ]) {
        es.addEventListener(name, onEvent);
      }

      es.onerror = () => {
        setSseConnected(false);
        es?.close();
        if (!closed) {
          retryTimer = window.setTimeout(connect, 1500);
        }
      };
    };

    connect();

    // Fast polling fallback (SSE may be buffered by some proxies)
    pollTimer = window.setInterval(() => {
      void qc.fetchQuery({
        queryKey: ["job", jobId],
        queryFn: async () => {
          const r = await fetch(`/api/v1/jobs/${jobId}`, {
            credentials: "include",
          });
          if (!r.ok) throw new Error("poll failed");
          return r.json() as Promise<JobDetail>;
        },
        staleTime: 0,
      }).then((detail) => {
        if (!detail) return;
        // stop hammering when terminal
        if (
          ["succeeded", "failed", "canceled", "partial"].includes(detail.status)
        ) {
          if (pollTimer) window.clearInterval(pollTimer);
          pollTimer = undefined;
        }
        mergeProgress({
          bytesDone: detail.bytesDone,
          bytesTotal: detail.bytesTotal,
          progressPct: detail.progressPct,
          status: detail.status,
        });
      }).catch(() => undefined);
    }, 1000);

    return () => {
      closed = true;
      setSseConnected(false);
      if (retryTimer) window.clearTimeout(retryTimer);
      if (pollTimer) window.clearInterval(pollTimer);
      es?.close();
    };
  }, [jobId, qc]);

  return { live, sseConnected };
}
