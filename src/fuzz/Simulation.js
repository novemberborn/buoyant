import { install as installClock } from 'lolex'

import Server from '../lib/Server'

import {
  ApplyEntry,
  PersistEntries,
  PersistState
} from './QueueManager'

export const Crashed = Symbol('Crashed')
export const BecameCandidate = Symbol('BecameCandidate')
export const BecameFollower = Symbol('BecameFollower')
export const BecameLeader = Symbol('BecameLeader')

export default class Simulation {
  constructor ({
    address,
    createTransport,
    electionTimeout,
    time = { epoch: 0, vector: 0 },
    heartbeatInterval,
    reportStateChange,
    restoreEntries,
    restoreLastApplied,
    restoreState,
    queueManager
  }) {
    this.address = address
    this.electionTimeout = electionTimeout

    const createStateChangeReporter = type => (...args) => reportStateChange(type, args)
    const createCallEnqueuer = type => (...args) => queueManager.enqueueCall(address, type, this.currentTime, args).promise
    this.server = new Server({
      address,
      applyEntry: createCallEnqueuer(ApplyEntry),
      crashHandler: createStateChangeReporter(Crashed),
      createTransport,
      electionTimeoutWindow: [electionTimeout, electionTimeout],
      heartbeatInterval,
      persistEntries: createCallEnqueuer(PersistEntries),
      persistState: createCallEnqueuer(PersistState)
    })
    this.server.on('candidate', createStateChangeReporter(BecameCandidate))
    this.server.on('follower', createStateChangeReporter(BecameFollower))
    this.server.on('leader', createStateChangeReporter(BecameLeader))

    this.raft = this.server._raft
    this.log = this.raft.log

    this.clock = installClock(this.raft.timers, time.epoch, ['clearInterval', 'setInterval', 'clearTimeout', 'setTimeout'])
    this.vectorClock = time.vector

    this.clockDelta = electionTimeout
    this.server.on('candidate', () => { this.clockDelta = electionTimeout })
    this.server.on('follower', () => { this.clockDelta = electionTimeout })
    this.server.on('leader', () => { this.clockDelta = heartbeatInterval })

    if (restoreState) this.server.restoreState(restoreState)
    if (restoreEntries) this.server.restoreLog(restoreEntries, restoreLastApplied)
  }

  advanceClock () {
    this.vectorClock++
    this.clock.next()
    return this.currentTime
  }

  append (value) {
    return this.server.append(value)
  }

  get isIdle () {
    return !this.raft.currentRole.scheduler.busy
  }

  get currentTime () {
    const {
      clock: { now: sinceEpoch },
      vectorClock: vector
    } = this
    return { sinceEpoch, vector }
  }

  get nextTime () {
    let {
      clock: { now: sinceEpoch },
      vectorClock: vector
    } = this
    sinceEpoch += this.clockDelta
    vector += 1
    return { sinceEpoch, vector }
  }

  destroy () {
    return this.server.destroy()
  }

  joinInitialCluster (addresses) {
    return this.server.join(addresses)
  }
}
