import { Noop } from './symbols'

// Applies log entries to the state machine, one at a time.
export default class LogEntryApplier {
  constructor ({ applyEntry, crashHandler }) {
    this.lastApplied = 0 // index of the entry that was last successfully applied
    this.lastQueued = 0 // index of the entry that was last enqueued to be applied

    this.busy = false
    this.queue = []

    this.applyEntry = applyEntry
    this.crashHandler = crashHandler
  }

  reset (lastApplied) {
    if (!Number.isSafeInteger(lastApplied) || lastApplied < 0) {
      throw new TypeError('Cannot reset log entry applier: last-applied index must be a safe, non-negative integer')
    }

    if (this.busy) {
      throw new Error('Cannot reset log entry applier while entries are being applied')
    }

    this.lastApplied = lastApplied
    this.lastQueued = lastApplied
  }

  enqueue (entry, resolve = null) {
    this.queue.push([entry, resolve])
    this.lastQueued = entry.index
    this.applyNext()
  }

  finish () {
    if (!this.busy) return Promise.resolve()

    return new Promise(resolve => {
      // Append a fake entry to resolve the finish promise once all entries have
      // been applied. Assumes no further entries are applied after this one.
      this.queue.push([{ index: this.lastQueued, value: Noop }, resolve])
    })
  }

  destroy () {
    this.queue = []
  }

  applyNext () {
    if (this.busy) return
    this.busy = true

    const [entry, resolve] = this.queue.shift()

    const next = result => {
      this.lastApplied = entry.index

      // Propagate the result from the state machine.
      if (resolve) {
        resolve(result)
      }

      // Process the next item, if any.
      this.busy = false
      if (this.queue.length > 0) {
        this.applyNext()
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
