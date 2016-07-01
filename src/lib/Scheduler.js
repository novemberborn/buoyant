// Operations that modify the Raft state or log must not interleave with each
// other. These operations are likely to be asynchronous in nature — this is
// Node.js after all!
//
// This module implements gatekeeper to ensure only one such operation is
// active, queueing future operations to be executed when possible.
export default class Scheduler {
  constructor (crashHandler) {
    this.crashHandler = crashHandler

    this.aborted = false
    this.busy = false
    this.queue = []
  }

  asap (handleAbort, fn) {
    if (this.aborted) {
      if (handleAbort) {
        handleAbort()
      }
      // Return a pending promise since the operation will never be executed,
      // but neither does it fail.
      return new Promise(() => {})
    }

    if (this.busy) {
      return new Promise(resolve => this.queue.push([handleAbort, resolve, fn]))
    }

    return this.run(fn)
  }

  abort () {
    this.aborted = true
    this.busy = false

    for (const [handleAbort] of this.queue) {
      if (handleAbort) {
        handleAbort()
      }
    }
    this.queue = null
  }

  crash (err) {
    this.crashHandler(err)
    // Return a pending promise as the error should be handled by the crash
    // handler.
    return new Promise(() => {})
  }

  run (fn) {
    let promise = null
    try {
      promise = fn()
    } catch (err) {
      return this.crash(err)
    }

    const next = () => {
      if (this.aborted || this.queue.length === 0) {
        this.busy = false
        return
      }

      const [, resolve, fn] = this.queue.shift()
      resolve(this.run(fn))
    }

    if (!promise) {
      return next()
    }

    this.busy = true
    // Note that the operations can't return results, just that they completed
    // successfully.
    return promise.then(next).catch(err => this.crash(err))
  }
}
