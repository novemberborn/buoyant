export default class ServerState {
  constructor (address) {
    this.address = address
    this.commitLog = new Map()
    this.currentTerm = null
    this.entries = []
    this.indexes = new Set()
    this.killed = false
    this.killTime = null
    this.lastApplied = 0
    this.pendingStateChanges = []
    this.role = null
    this.state = {}
    this.sum = 0
    this.votedFor = null
  }

  applyEntry (entry) {
    this.commitLog.set(entry.index, entry.term)
    this.lastApplied = entry.index
    this.sum += entry.value
    return this.sum
  }

  changeRole (role) {
    this.role = role
  }

  get isLeader () {
    return this.role === 'leader'
  }

  kill (time) {
    this.killed = true
    this.killTime = time
    this.pendingStateChanges = []
    this.role = null
  }

  persistEntries (entries) {
    let overwrittenOrDeleted = 0

    for (const entry of entries) {
      for (let ix = entry.index; this.indexes.has(ix); ix++) {
        this.indexes.delete(ix)
        overwrittenOrDeleted++
      }

      this.entries.push(entry)
      this.indexes.add(entry.index)
    }

    return overwrittenOrDeleted
  }

  persistState (currentTerm, votedFor) {
    this.currentTerm = currentTerm
    this.votedFor = votedFor
  }

  restart () {
    const { currentTerm, entries, killTime: time, lastApplied, votedFor } = this
    this.killed = false
    this.killTime = null

    if (currentTerm === null) {
      return { time }
    }

    return {
      restoreEntries: entries,
      restoreLastApplied: lastApplied,
      restoreState: { currentTerm, votedFor },
      time
    }
  }
}
