/** One recorded spend, in USD, at a wall-clock millisecond. */
export interface SpendRecord {
  at: number;
  usd: number;
}

/**
 * Where rolling spend totals live. The default is in-memory and per-process; swap in a
 * shared implementation (Redis, Durable Object, Postgres) when an agent runs as more
 * than one process, otherwise each process enforces its own separate budget.
 */
export interface SpendStore {
  record(entry: SpendRecord): Promise<void> | void;
  /** Total USD recorded at or after `sinceMs`. */
  totalSince(sinceMs: number): Promise<number> | number;
}

/** Process-local store. Entries older than the longest window are dropped on write. */
export function createMemorySpendStore(retentionMs = 24 * 60 * 60 * 1000): SpendStore {
  let entries: SpendRecord[] = [];

  return {
    record(entry) {
      entries.push(entry);
      const cutoff = entry.at - retentionMs;
      if (entries.length > 64) entries = entries.filter((e) => e.at >= cutoff);
    },
    totalSince(sinceMs) {
      let total = 0;
      for (const entry of entries) if (entry.at >= sinceMs) total += entry.usd;
      return total;
    },
  };
}
