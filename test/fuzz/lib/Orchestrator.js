import { Readable } from 'stream'

export default class Orchestrator {
  constructor (configuration) {
    this.configuration = configuration
    configuration.on('stateChange', this._handleStateChange.bind(this))

    this.activeRoles = {
      candidate: new Map(),
      follower: new Map(),
      leader: new Map()
    }
    this.halt = false
    this.log = new Readable({ objectMode: true, read () {} })
    this.previousRoles = new Map()
  }

  async drain () {
    // Allow all activity until each proces has become idle.
    const { internalEvents, network } = this.configuration
    while (internalEvents.length > 0 && !this.halt) {
      this._handleInternalEvent(internalEvents.shift())
    }
    while (network.hasQueued() && !this.halt) {
      this._handleMessage(network.dequeue())
    }

    // Allow promise resolution to propagate, and the delivered messages to be
    // consume. Use setImmediate() so draining can resume *after* any
    // micro-tasks or nextTicks have run.
    await new Promise(resolve => setImmediate(resolve))

    if (this.halt) return false
    if (internalEvents.length === 0 && !network.hasQueued()) return true
    return this.drain()
  }

  async run () {
    this.log.push({
      type: 'initialCluster',
      size: this.configuration.processes.size,
      addresses: this.configuration.addresses.slice()
    })
    await this.configuration.joinInitialCluster()

    // Advance the clock of a random process. This will cause it to start an
    // election.
    this.configuration.randomProcess().advanceClock()

    // Let the election run its course.
    await this.drain()

    // There should be a leader
    if (this.activeRoles.leader.size !== 1) {
      throw new Error('No leader')
    }

    console.log(this.activeRoles)
  }

  _handleInternalEvent (evt) {
    const { args, event, process: { address }, resolve, timestamp } = evt
    const record = { address, timestamp, type: event }

    // TODO Verify predicates
    switch (event) {
      case 'applyEntry':
        const [entry] = args
        record.entry = entry
        break

      case 'persistEntries':
        const [entries] = args
        record.entries = entries
        break

      case 'persistState':
        const [{ currentTerm, votedFor }] = args
        record.currentTerm = currentTerm
        record.votedFor = votedFor
        break

      default:
        throw new Error(`Unexpected internal event: ${event}`)
    }

    this.log.push(record)
    resolve()
  }

  _handleMessage (message) {
    const { deliveries, id, payload, queued, receiver, sender, timestamp } = message
    const record = { id, payload, queued, receiver, sender, timestamp }

    // Log with an incremented count because the message will be delivered after
    // logging.
    record.deliveries = deliveries + 1
    record.type = 'deliverMessage'
    this.log.push(record)
    message.deliver()
  }

  _handleStateChange (process, event, ...args) {
    if (this.halt) return // Don't spoil the log with further events

    const { address } = process
    const record = { address, timestamp: process.currentTime }

    switch (event) {
      case 'crash':
        const [err] = args
        record.err = err
        record.type = 'serverCrash'
        this.log.push(record)

        // Orchestration must halt if there are crashed processes
        this.halt = true
        break

      case 'candidate':
      case 'follower':
      case 'leader':
        const [term] = args
        record.term = term
        record.type = `is${event[0].toUpperCase()}${event.slice(1)}`
        this.log.push(record)

        if (this.previousRoles.has(address)) {
          this.activeRoles[this.previousRoles.get(address)].delete(address)
        }
        this.previousRoles.set(address, event)
        this.activeRoles[event].set(address, term)

        const leaders = this.activeRoles.leader
        if (leaders.size > 1) {
          // Find other leaders for the same term. There may be leaders with an
          // older term, they won't have realized yet they've been deposed.
          const otherLeaders = Array.from(leaders.keys()).filter(otherAddress => {
            return otherAddress !== address && leaders.get(otherAddress) === term
          })
          if (otherLeaders.length > 0) {
            this.halt = true
            this.log.push({
              address,
              otherLeaders,
              property: 'electionSafety',
              term,
              timestamp: process.currentTime,
              type: 'predicateViolation'
            })
          }
        }
        break

      default:
        throw new Error(`Unexpected state change: ${event}`)
    }
  }

}
