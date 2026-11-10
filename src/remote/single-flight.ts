/**
 * One run per key at a time: callers arriving while it is in flight share its
 * result instead of starting their own. Remote mode uses it for the retrieve
 * requests of a job (key: hashed user + job id), so 30 polls of the same
 * finished video, in a batch or from several sessions, download it once.
 *
 * Each caller keeps its own cancellation: one that aborts leaves (and gets
 * "Cancelled") while the others keep waiting; the run itself is aborted only
 * when every caller has left.
 */
export class SingleFlight {
  private readonly runs = new Map<string, { promise: Promise<unknown>; waiters: number; ctl: AbortController }>()

  /** Runs in flight (tests). */
  get size(): number {
    return this.runs.size
  }

  run<T>(key: string, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error('Cancelled'))
    let entry = this.runs.get(key)
    if (!entry) {
      const ctl = new AbortController()
      const fresh = { waiters: 0, ctl, promise: Promise.resolve() as Promise<unknown> }
      fresh.promise = Promise.resolve()
        .then(() => work(ctl.signal))
        .finally(() => {
          if (this.runs.get(key) === fresh) this.runs.delete(key)
        })
      fresh.promise.catch(() => undefined) // every caller may have left: never an unhandled rejection
      this.runs.set(key, fresh)
      entry = fresh
    }
    const run = entry
    run.waiters++
    return new Promise<T>((resolve, reject) => {
      let left = false
      const leave = () => {
        if (left) return false
        left = true
        signal?.removeEventListener('abort', onAbort)
        run.waiters--
        return true
      }
      const onAbort = () => {
        if (!leave()) return
        if (run.waiters === 0) {
          // Nobody waits any more: stop the work, and let the next caller start afresh.
          if (this.runs.get(key) === run) this.runs.delete(key)
          run.ctl.abort()
        }
        reject(new Error('Cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      run.promise.then(
        (v) => leave() && resolve(v as T),
        (e) => leave() && reject(e),
      )
    })
  }
}
