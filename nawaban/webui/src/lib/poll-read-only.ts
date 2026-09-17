export const TASK_REFRESH_MS = 30_000;

export function pollReadOnly<T>(
  load: () => Promise<T>,
  onData: (data: T) => void,
  onError: (error: unknown) => void,
) {
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const refresh = async () => {
    try {
      const data = await load();
      if (active) onData(data);
    } catch (error) {
      if (active) onError(error);
    } finally {
      if (active) timer = setTimeout(refresh, TASK_REFRESH_MS);
    }
  };
  void refresh();
  return () => {
    active = false;
    clearTimeout(timer);
  };
}
