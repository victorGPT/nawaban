import { useCallback, useEffect, useRef, useState } from "react";
import { pollReadOnly } from "./poll-read-only.ts";

export function useReadOnlyData<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const poll = useRef<ReturnType<typeof pollReadOnly<T>> | null>(null);
  useEffect(() => {
    const controller = pollReadOnly(load, (next) => {
      setData(next);
      setError("");
      setUpdatedAt(new Date());
    }, (failure) => setError(String(failure)), setRefreshing);
    poll.current = controller;
    return () => { controller(); poll.current = null; };
  }, [load]);
  const refresh = useCallback(() => { void poll.current?.refresh(); }, []);
  return { data, error, updatedAt, refreshing, refresh };
}
