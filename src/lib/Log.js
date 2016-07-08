import Entry from './Entry'

// Manages the log for each server. Contains all entries. Responsible for
// persisting new entries and committing them to the state machine.
export default class Log {
  constructor ({ applier, persistEntries }) {
    this.entries = new Map()
    this.lastIndex = 0
    this.lastTerm = 0

    this.applier = applier
    this.persistEntries = persistEntries
  }

  close () {
    // Assume calling code already takes care of preventing other log operations
    // from occurring. Return a promise for when the last queued entry has been
    // applied.
    return this.applier.finish()
  }

  destroy () {
    // Assume calling code already takes care of preventing other log operations
    // from occurring. Force the asynchronous log application to stop.
    this.applier.destroy()
  }

  replace (entries, lastApplied = 0) {
    this.applier.reset(lastApplied)
    this.entries.clear()

    let last = { index: 0, term: 0 }
    for (const entry of entries) {
      // Resolve conflicts within the entries so the persistence implementation
      // does not have to worry about them.
      //
      // Assumes entries are ordered correctly.
      if (this.entries.has(entry.index)) {
        this.deleteConflictingEntries(entry.index)
      }
      this.entries.set(entry.index, entry)
      last = entry
    }

    this.lastIndex = last.index
    this.lastTerm = last.term
  }

  deleteConflictingEntries (fromIndex) {
    for (let ix = fromIndex; this.entries.has(ix); ix++) {
      this.entries.delete(ix)
    }
  }

  getTerm (index) {
    // Note that the log starts at index 1, so if index 0 is requested then
    // return the default term value.
    if (index === 0) return 0

    // Get the term of the entry at the given index. Rightfully crash if the
    // entry does not exist.
    return this.entries.get(index).term
  }

  getEntry (index) {
    return this.entries.get(index)
  }

  getEntriesSince (index) {
    const entries = []
    for (let ix = index; ix <= this.lastIndex; ix++) {
      entries.push(this.entries.get(ix))
    }
    return entries
  }

  async appendValue (currentTerm, value) {
    const entry = new Entry(this.lastIndex + 1, currentTerm, value)

    await this.persistEntries([entry])

    // Persistence is asynchronous, yet `lastIndex` is set to the entry's index
    // when it's finished. This assumes the calling code does not perform any
    // other operations that affect the log.
    this.lastIndex = entry.index
    this.lastTerm = entry.term
    this.entries.set(entry.index, entry)

    return entry
  }

  async mergeEntries (entries, prevLogIndex, prevLogTerm) {
    if (this.lastIndex > prevLogIndex) {
      // The log contains extra entries that are not present on the leader.
      // Remove them to achieve convergence.
      this.deleteConflictingEntries(prevLogIndex + 1)
      this.lastIndex = prevLogIndex
      this.lastTerm = prevLogTerm
    }

    // Clean up the list of entries before persisting them. Entries that are
    // already in the log don't need to be persisted again.
    entries = entries.filter(entry => {
      return !this.entries.has(entry.index) || this.entries.get(entry.index).term !== entry.term
    })

    if (entries.length === 0) return

    await this.persistEntries(entries)

    // Like `appendValue()` this assumes the calling code does not perform any
    // other operations that affect the log.
    let last
    for (const entry of entries) {
      // Overwrite the log if necessary.
      if (this.entries.has(entry.index)) {
        this.deleteConflictingEntries(entry.index)
      }

      this.entries.set(entry.index, entry)
      last = entry
    }

    this.lastIndex = last.index
    this.lastTerm = last.term
  }

  commit (index) {
    return new Promise(resolve => {
      // Make sure any previous entries are being applied.
      for (let prevIndex = this.applier.lastQueued + 1; prevIndex < index; prevIndex++) {
        this.applier.enqueue(this.getEntry(prevIndex))
      }

      // Add this entry to the queue
      this.applier.enqueue(this.getEntry(index), resolve)
    })
  }
}
