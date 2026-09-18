export const TASK_REFRESH_MS = 30_000;

export function pollReadOnly<T>(
  load: () => Promise<T>,
  onData: (data: T) => void,
  onError: (error: unknown) => void,
  onRefreshing: (refreshing: boolean) => void = () => {},
) {
  let active = true;
  let pending = false;
  let timer: ReturnType<typeof setTimeout>;
  const refresh = async () => {
    // Manual refresh and the timer share one in-flight read.
    if (!active || pending) return;
    clearTimeout(timer);
    pending = true;
    onRefreshing(true);
    try {
      const data = await load();
      if (active) onData(data);
    } catch (error) {
      if (active) onError(error);
    } finally {
      pending = false;
      if (active) onRefreshing(false);
      if (active) timer = setTimeout(refresh, TASK_REFRESH_MS);
    }
  };
  void refresh();
  const stop = () => {
    active = false;
    clearTimeout(timer);
  };
  return Object.assign(stop, { refresh });
}
