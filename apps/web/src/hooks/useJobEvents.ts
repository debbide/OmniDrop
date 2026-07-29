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
          if (!data || typeof data !== "object") return;

          const eventName = (ev as MessageEvent & { type?: string }).type
            || "";

          // target.updated: patch one target row + surface bytes on job bar during upload
          if (eventName === "target.updated" || data.jobTargetId) {
            const tid = String(
              data.jobTargetId ?? data.id ?? "",
            );
            const tBytes =
              typeof data.bytesDone === "number" ? data.bytesDone : undefined;
            const tTotal =
              typeof data.bytesTotal === "number"
                ? data.bytesTotal
                : data.bytesTotal === null
                  ? null
                  : undefined;
            const tPct =
              typeof data.progressPct === "number"
                ? data.progressPct
                : tBytes != null && tTotal != null && tTotal > 0
                  ? Math.min(100, Math.round((tBytes / tTotal) * 100))
                  : undefined;

            // During upload, top bar should follow target transfer
            if (tBytes != null || tPct != null || data.status === "uploading") {
              mergeProgress({
                bytesDone: tBytes,
                bytesTotal: tTotal,
                progressPct: tPct,
                status:
                  typeof data.status === "string" &&
                  data.status === "uploading"
                    ? "uploading"
                    : undefined,
                phase: "uploading",
              });
            }

            if (tid) {
              qc.setQueryData<JobDetail>(["job", jobId], (old) => {
                if (!old?.targets) return old;
                return {
                  ...old,
                  status:
                    data.status === "uploading" ? "uploading" : old.status,
                  bytesDone: tBytes ?? old.bytesDone,
                  bytesTotal:
                    tTotal !== undefined ? tTotal : old.bytesTotal,
                  progressPct: tPct ?? old.progressPct,
                  targets: old.targets.map((t) =>
                    t.id === tid
                      ? {
                          ...t,
                          status:
                            typeof data.status === "string"
                              ? data.status
                              : t.status,
                          bytesDone: tBytes ?? t.bytesDone,
                          bytesTotal:
                            tTotal !== undefined ? tTotal : t.bytesTotal,
                          progressPct: tPct ?? t.progressPct,
                          errorMessage:
                            typeof data.errorMessage === "string"
                              ? data.errorMessage
                              : t.errorMessage,
                          remoteFinalPath:
                            typeof data.remoteFinalPath === "string"
                              ? data.remoteFinalPath
                              : t.remoteFinalPath,
                        }
                      : t,
                  ),
                };
              });
            }
          } else {
            // job.updated / job.finished / full snapshot
            mergeProgress(data);
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
        // Full refetch less often for consistency (steps list etc.)
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
          const r = await fetch(`/api/v1/jobs/${jobId}?_t=${Date.now()}`, {
            credentials: "include",
            cache: "no-store",
            headers: {
              "Cache-Control": "no-cache",
              Pragma: "no-cache",
            },
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
        // Prefer active target transfer bytes when uploading
        const activeUpload = (detail.targets ?? []).find(
          (t) => t.status === "uploading",
        );
        const anySucceeded = (detail.targets ?? []).some(
          (t) => t.status === "succeeded",
        );
        const pick =
          activeUpload ??
          (detail.status === "uploading"
            ? (detail.targets ?? []).find((t) => (t.bytesDone ?? 0) > 0)
            : undefined);
        if (pick && (detail.status === "uploading" || activeUpload)) {
          const tDone = pick.bytesDone ?? 0;
          const tTotal = pick.bytesTotal ?? detail.bytesTotal;
          const tPct =
            tTotal && tTotal > 0
              ? Math.min(100, Math.round((tDone / tTotal) * 100))
              : pick.progressPct;
          mergeProgress({
            bytesDone: tDone,
            bytesTotal: tTotal,
            progressPct: tPct,
            status: detail.status,
            phase: "uploading",
          });
        } else if (anySucceeded && detail.status === "succeeded") {
          mergeProgress({
            bytesDone: detail.bytesDone,
            bytesTotal: detail.bytesTotal,
            progressPct: 100,
            status: detail.status,
          });
        } else {
          mergeProgress({
            bytesDone: detail.bytesDone,
            bytesTotal: detail.bytesTotal,
            progressPct: detail.progressPct,
            status: detail.status,
          });
        }
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
