import { Noop } from './symbols'

// Applies log entries to the state machine, one at a time.
export default class LogEntryApplier {
  constructor ({ applyEntry, crashHandler }) {
    this.lastApplied = 0 // index of the entry that was last successfully applied
    this.lastQueued = 0 // index of the entry that was last enqueued to be applied

    this.processing = false
    this.queue = []

    this.applyEntry = applyEntry
    this.crashHandler = crashHandler
  }

  reset (lastApplied) {
    if (!Number.isInteger(lastApplied) || lastApplied < 0 || !Number.isSafeInteger(lastApplied)) {
      throw new TypeError('Cannot reset log entry applier: last-applied index must be a safe, non-negative integer')
    }

    if (this.queue.length > 0) {
      throw new Error('Cannot reset log entry applier while entries are being applied')
    }

    this.lastApplied = lastApplied
    this.lastQueued = lastApplied
  }

  enqueue (entry, resolve = null) {
    this.queue.push([entry, resolve])
    this.lastQueued = entry.index

    // Start applying entries if this is the first new one.
    if (!this.processing) {
      this.processQueue()
    }
  }

  finish () {
    if (!this.processing) return Promise.resolve()

    return new Promise(resolve => {
      // Append a fake entry to resolve the finish promise once all entries have
      // been applied. Assumes no further entries are applied after this one.
      this.queue.push([{ index: this.lastQueued, value: Noop }, resolve])
    })
  }

  destroy () {
    this.queue = []
  }

  processQueue () {
    this.processing = true

    const [entry, resolve] = this.queue.shift()

    const next = result => {
      this.lastApplied = entry.index

      // Propagate the result from the state machine.
      if (resolve) {
        resolve(result)
      }

      // Process the next item, if any.
      if (this.queue.length > 0) {
        this.processQueue()
      } else {
        this.processing = false
      }
    }

    if (entry.value === Noop) {
      // No-ops do not need to be applied.
      next(undefined)
    } else {
      this.applyEntry(entry).then(next, this.crashHandler)
    }
  }
}
