/**
 * First come, first served, with at most [maxConcurrent] tasks running: sharing 50 videos at once
 * must not start 50 downloads, transcriptions and AI calls on a small server.
 */
export class TaskQueue<T extends { sourceId: string }> {
  private waiting: { item: T; run: () => Promise<void> }[] = [];
  private running = 0;

  constructor(
    private readonly maxConcurrent: number,
    /** Called whenever the line changes, with the items still waiting in order. */
    private readonly onWaitingChanged: (waiting: T[]) => void = () => {},
    private readonly onStart: (item: T) => void = () => {}
  ) {}

  /** Queues [run] for [item]; queuing an item that's already waiting keeps only the newest run. */
  enqueue(item: T, run: () => Promise<void>) {
    this.waiting = this.waiting.filter(entry => entry.item.sourceId !== item.sourceId);
    this.waiting.push({ item, run });
    this.pump();
  }

  get runningCount(): number {
    return this.running;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  private pump() {
    while (this.running < Math.max(1, this.maxConcurrent) && this.waiting.length > 0) {
      const { item, run } = this.waiting.shift()!;
      this.running++;
      this.onStart(item);
      Promise.resolve()
        .then(run)
        .catch(err => console.error(`[Queue] ${item.sourceId} crashed:`, err))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
    this.onWaitingChanged(this.waiting.map(entry => entry.item));
  }
}
