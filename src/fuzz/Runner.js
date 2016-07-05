import intInRange from './int-in-range'
import {
  AdvanceClock,
  Append,
  Deliver,
  DeliverAndRequeue,
  Drop,
  FailCall,
  Kill,
  Partition,
  pickSimulationEvent,
  pickWorldEvent,
  Requeue,
  Restart,
  RunSimulation,
  CallOrDeliver,
  UndoPartition
} from './event-generator'
import pickRandom from './pick-random'
import {
  ElectionSafetyViolation,
  LeaderAppendOnlyViolation,
  LeaderCompletenessViolation,
  LogMatchingViolation,
  StateMachineSafetyViolation
} from './predicate-violations'
import ServerState from './ServerState'
import {
  BecameCandidate,
  BecameFollower,
  BecameLeader,
  Crashed
} from './Simulation'
import {
  ApplyEntry,
  PersistEntries,
  PersistState
} from './QueueManager'

export default class Runner {
  constructor ({ configuration, reporter }) {
    const { addresses, network, queueManager } = configuration
    Object.assign(this, { configuration, network, queueManager, reporter })

    this.appliedEntries = new Map()
    this.serverStates = addresses.reduce((states, address) => states.set(address, new ServerState(address)), new Map())
    configuration.on('stateChange', evt => this.getState(evt.address).pendingStateChanges.push(evt))
  }

  getState (address) {
    return this.serverStates.get(address)
  }

  getPeerStates (address) {
    return Array.from(this.serverStates.values()).filter(({ address: peerAddress }) => peerAddress !== address)
  }

  getSimulation (address) {
    return this.configuration.getSimulation(address)
  }

  getLeader () {
    const [address] = Array.from(this.serverStates)
      // Get just the leaders.
      .filter(([, state]) => state.isLeader)
      // Sort by term, highest first. There may be leaders with an older term,
      // but they can be ignored.
      .sort(([, { term: a }], [, { term: b }]) => b - a)
      .map(([address]) => address)

    return address ? this.getSimulation(address) : null
  }

  killServer ({ address, currentTime }) {
    this.getState(address).kill(currentTime)
  }

  verifyElectionSafety ({ address, currentTime }, term) {
    // Find other leaders for the same term. There may be leaders with an older
    // term, they won't have realized yet they've been deposed.
    const otherLeaders = this.getPeerStates(address)
      .filter(({ currentTerm, isLeader }) => isLeader && currentTerm === term)
      .map(({ address, currentTerm }) => ({ address, currentTerm }))

    if (otherLeaders.length > 0) {
      throw new ElectionSafetyViolation({
        address,
        otherLeaders,
        term,
        timestamp: currentTime
      })
    }
  }

  verifyLeaderAppendOnly ({ address }, entry, timestamp) {
    const { isLeader, lastApplied } = this.getState(address)
    if (isLeader && entry.index <= lastApplied) {
      throw new LeaderAppendOnlyViolation({
        address,
        entry,
        lastApplied,
        timestamp
      })
    }
  }

  verifyLeaderCompleteness ({ address, currentTime, log }) {
    for (const [index, term] of this.appliedEntries) {
      const entry = log.getEntry(index)
      if (!entry || entry.term !== term) {
        throw new LeaderCompletenessViolation({
          address,
          index,
          term,
          timestamp: currentTime
        })
      }
    }
  }

  verifyLogMatching () {
    const { addressLookup, logs } = this.configuration.getLogs().reduce((acc, { address, log }) => {
      acc.addressLookup.set(log, address)
      acc.logs.push(log)
      return acc
    }, { addressLookup: new Map(), logs: [] })

    // Shortest log first, excluding empty ones.
    const nonEmptyLogs = logs.filter(log => log.lastIndex > 0).sort((a, b) => b.lastIndex - a.lastIndex)

    const findMatchIndex = (log1, log2) => {
      for (let index = log1.lastIndex; index > 0; index--) {
        const entry1 = log1.getEntry(index)
        const entry2 = log2.getEntry(index)
        if (entry1 && entry2 && entry1.term === entry2.term) {
          return index
        }
      }

      return 0
    }

    const describeLog = (log, entry) => {
      const address = addressLookup.get(log)
      const { currentTime: timestamp } = this.getSimulation(address)
      return { address, timestamp, entry }
    }

    while (nonEmptyLogs.length > 1) {
      const log1 = nonEmptyLogs.shift()
      const log2 = nonEmptyLogs[0]

      for (let index = findMatchIndex(log1, log2); index > 0; index--) {
        const entry1 = log1.getEntry(index)
        const entry2 = log2.getEntry(index)
        if (entry1 && !entry2 || !entry1 && entry2 || entry1.term !== entry2.term) {
          throw new LogMatchingViolation({
            index,
            first: describeLog(log1, entry1),
            second: describeLog(log2, entry2)
          })
        }
      }
    }
  }

  verifyStateMachineSafety ({ address }, entry, timestamp) {
    const peersWithEntry = this.getPeerStates(address)
      .filter(({ commitLog }) => commitLog.has(entry.index))

    for (const { address: peerAddress, commitLog } of peersWithEntry) {
      const existingTerm = commitLog.get(entry.index)
      if (entry.term !== existingTerm) {
        throw new StateMachineSafetyViolation({
          address,
          timestamp,
          entry,
          peer: {
            address: peerAddress,
            term: existingTerm
          }
        })
      }
    }
  }

  async run () {
    await this.configuration.joinInitialCluster()
    const simulation = this.configuration.triggerElection()

    await new Promise((resolve, reject) => this.loop(simulation, resolve, reject))
  }

  async loop (simulation, done, fail) {
    if (!this.configuration.hasActiveSimulations()) return done()

    if (!simulation) {
      const action = pickWorldEvent()
      if (action === RunSimulation) {
        simulation = this.configuration.getTrailingSimulation()
        this.loop(simulation, done, fail)
        return
      }

      try {
        await this[action]()
        setTimeout(() => this.loop(null, done, fail), 10)
      } catch (err) {
        fail(err)
      }

      return
    }

    try {
      const { address } = simulation
      const state = this.getState(address)
      if (state.pendingStateChanges.length > 0) {
        const { args, type } = state.pendingStateChanges.shift()
        await this[type](simulation, ...args)
      } else {
        const action = pickSimulationEvent()
        await this[action](simulation)
        this.verifyLogMatching()
      }

      if (
        state.killed ||
        (
          !state.pendingStateChanges.length &&
          !this.queueManager.hasQueuedDeliveries(address) &&
          !this.queueManager.hasQueuedCalls(address) &&
          simulation.isIdle
        )
      ) {
        setTimeout(() => this.loop(null, done, fail), 10)
      } else {
        setTimeout(() => this.loop(simulation, done, fail), 10)
      }
    } catch (err) {
      fail(err)
    }
  }

  makeDelivery (simulation, delivery, requeue) {
    this.network.deliver(simulation.address, delivery)

    if (requeue) {
      this.reporter.requeue(simulation, delivery)
      delivery.requeue()
    }
  }

  // World events
  [Append] () {
    const leader = this.getLeader()
    if (leader) {
      const value = intInRange([-100, 100])
      this.reporter.append(leader, value)
      leader.append(value)
        .then(sum => this.reporter.commit(leader, sum))
        .catch(() => this.reporter.noCommit(leader, value))
    }
  }

  async [Kill] () {
    const simulation = await this.configuration.killRandomSimulation()
    this.killServer(simulation)
  }

  [Partition] () {
    this.network.partition()
  }

  async [Restart] () {
    const killed = Array.from(this.serverStates)
      .filter(([, state]) => state.killed)
      .map(([address]) => address)

    if (killed.length > 0) {
      const address = pickRandom(killed)
      const { restoreEntries, restoreLastApplied, restoreState, time } = this.getState(address).restart()
      await this.configuration.restartSimulation(address, restoreEntries, restoreLastApplied, restoreState, time)
    }
  }

  [UndoPartition] () {
    this.network.undoPartition()
  }

  // State changes
  [BecameCandidate] (simulation) {
    this.reporter.becameCandidate(simulation)
    this.getState(simulation.address).changeRole('candidate')
  }

  [BecameFollower] (simulation) {
    this.reporter.becameFollower(simulation)
    this.getState(simulation.address).changeRole('follower')
  }

  [BecameLeader] (simulation, term) {
    const { address } = simulation
    this.reporter.becameLeader(simulation, term)
    this.getState(address).changeRole('leader')

    this.verifyElectionSafety(simulation, term)
    this.verifyLeaderCompleteness(simulation)
  }

  async [Crashed] (simulation, err) {
    if (err === FailCall) {
      const { address } = simulation
      this.reporter.intentionalCrash(simulation)

      await this.configuration.killSimulation(address, true)
      this.killServer(simulation)
    } else {
      this.reporter.crash(simulation, err)
      throw err
    }
  }

  // Simulation events
  [AdvanceClock] () {
    this.configuration.advanceTrailingClock()
  }

  [CallOrDeliver] (simulation) {
    const { address } = simulation
    if (this.queueManager.hasQueuedCalls(address)) {
      const call = this.queueManager.dequeueCall(address)
      this[call.type](simulation, call)
    } else {
      this[Deliver](simulation)
    }
  }

  [Deliver] (simulation) {
    const { address } = simulation
    if (this.queueManager.hasQueuedDeliveries(address)) {
      this.makeDelivery(simulation, this.queueManager.dequeueDelivery(address), false)
    }
  }

  [DeliverAndRequeue] (simulation) {
    const { address } = simulation
    if (this.queueManager.hasQueuedDeliveries(address)) {
      this.makeDelivery(simulation, this.queueManager.dequeueDelivery(address), true)
    }
  }

  [Drop] (simulation) {
    const { address } = simulation
    if (this.queueManager.hasQueuedDeliveries(address)) {
      const delivery = this.queueManager.dequeueDelivery(address)
      this.reporter.dropMessage(simulation, delivery)
    }
  }

  [FailCall] (simulation) {
    const { address } = simulation
    if (this.queueManager.hasQueuedCalls(address)) {
      const call = this.queueManager.dequeueCall(address)
      this.reporter.failCall(simulation, call)
      call.reject(FailCall)
    }
  }

  [Requeue] (simulation) {
    const { address } = simulation
    if (this.queueManager.hasQueuedDeliveries(address)) {
      const delivery = this.queueManager.dequeueDelivery(address)
      this.reporter.requeue(simulation, delivery)
      delivery.requeue()
    }
  }

  // Call handlers
  [ApplyEntry] (simulation, call) {
    const { address } = simulation
    const { args: [entry], timestamp } = call
    this.reporter.applyEntry(simulation, call)

    this.verifyLeaderAppendOnly(simulation, entry, timestamp)

    this.appliedEntries.set(entry.index, entry.term)
    const sum = this.getState(address).applyEntry(entry)

    this.verifyStateMachineSafety(simulation, entry, timestamp)
    call.resolve(sum)
  }

  [PersistEntries] (simulation, call) {
    const { args: [entries] } = call
    this.reporter.persistEntries(simulation, call)
    this.getState(simulation.address).persistEntries(entries)
    call.resolve()
  }

  [PersistState] (simulation, call) {
    const { args: [{ currentTerm, votedFor }] } = call
    this.reporter.persistState(simulation, call)
    this.getState(simulation.address).persistState(currentTerm, votedFor)
    call.resolve()
  }
}
