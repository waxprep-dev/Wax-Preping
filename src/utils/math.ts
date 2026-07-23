export function clamp01(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : fallback;
  return Math.max(0, Math.min(1, n));
}

export function f2(n: number): string {
  return n.toFixed(2);
}

export function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
