/** Tiny async mutex so a sync's export → merge → write window can't interleave with a turn commit. */
let tail: Promise<unknown> = Promise.resolve();

export function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
