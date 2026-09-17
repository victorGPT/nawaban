import { useEffect, useState } from "react";
import { pollReadOnly } from "./poll-read-only.ts";

export function useReadOnlyData<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  useEffect(() => pollReadOnly(load, (next) => {
    setData(next);
    setError("");
  }, (failure) => setError(String(failure))), [load]);
  return { data, error };
}
