import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useJobEvents(jobId: string | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!jobId) return;
    let es: EventSource | null = null;
    let closed = false;
    let retryTimer: number | undefined;

    const connect = () => {
      if (closed) return;
      es = new EventSource(`/api/v1/jobs/${jobId}/events`, {
        withCredentials: true,
      });

      const invalidate = () => {
        void qc.invalidateQueries({ queryKey: ["job", jobId] });
        void qc.invalidateQueries({ queryKey: ["jobs"] });
      };

      for (const ev of [
        "job.updated",
        "step.updated",
        "target.updated",
        "job.finished",
      ]) {
        es.addEventListener(ev, invalidate);
      }

      es.onerror = () => {
        es?.close();
        retryTimer = window.setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      es?.close();
    };
  }, [jobId, qc]);
}
