export const MIN_STATUS_FRESH_MS = 45_000;

export function statusStaleAfterMs(syncSeconds: number): number {
  const seconds = Number.isFinite(syncSeconds) && syncSeconds > 0 ? syncSeconds : 15;
  return Math.max(MIN_STATUS_FRESH_MS, seconds * 1000 + 5_000);
}

export function groupListRefreshMs(syncSeconds: number): number {
  const seconds = Number.isFinite(syncSeconds) && syncSeconds > 0 ? syncSeconds : 15;
  return Math.max(60_000, seconds * 1000);
}
