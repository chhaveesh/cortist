/**
 * Transport-agnostic queue port.
 *
 * The gateway depends only on this abstract class. Swapping BullMQ for SQS
 * means providing a different implementation in QueueModule — no controller or
 * service in the ingestion path changes.
 */
export interface EnqueueOptions {
  /**
   * Deterministic identifier for the job. Implementations that support it
   * (BullMQ, SQS FIFO deduplication ids) use this to reject duplicates.
   */
  jobId?: string;

  /** Delay before the job becomes visible to consumers, in milliseconds. */
  delayMs?: number;
}

export interface EnqueueResult {
  /** The id the backend assigned (or echoed back) for this job. */
  jobId: string;

  /**
   * False when the backend recognised the job as a duplicate and did not add
   * new work. Callers may use this for metrics; correctness must not depend on
   * it, since not every backend can report it.
   */
  enqueued: boolean;
}

export abstract class QueueService {
  /**
   * Publish a job. Implementations must be safe to call concurrently and must
   * not throw for duplicate `jobId`s — report them via `enqueued: false`.
   */
  abstract enqueue<T extends object>(
    queueName: string,
    jobName: string,
    payload: T,
    options?: EnqueueOptions,
  ): Promise<EnqueueResult>;

  /** Number of jobs waiting to be picked up. Used by tests and health checks. */
  abstract countWaiting(queueName: string): Promise<number>;
}
