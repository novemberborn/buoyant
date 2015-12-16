import { install as installClock } from 'lolex'

import { createServer } from '🏠'
import exposeEvents from '🏠/lib/expose-events'

export default class Process {
  constructor (address, createTransport) {
    const emitter = exposeEvents(this)

    const createInternalEventEmitter = event => {
      return (...args) => {
        return new Promise((resolve, reject) => {
          emitter.emit(event, resolve, reject, ...args)
        })
      }
    }

    const createStateChangeEmitter = event => {
      return (...args) => emitter.emit(event, ...args)
    }

    this.address = address
    this._server = createServer({
      address,
      applyEntry: createInternalEventEmitter('applyEntry'),
      crashHandler: createStateChangeEmitter('crash'),
      createTransport,
      electionTimeoutWindow: [10, 20],
      heartbeatInterval: 5,
      persistEntries: createInternalEventEmitter('persistEntries'),
      persistState: createInternalEventEmitter('persistState')
    })

    ;['candidate', 'follower', 'leader'].forEach(event => {
      this._server.on(event, createStateChangeEmitter(event))
    })
    this._raft = this._server._raft

    this._vectorClock = 0
    this._clock = installClock(this._raft.timers, 0, ['clearInterval', 'setInterval', 'clearTimeout', 'setTimeout'])
  }

  advanceClock () {
    this._vectorClock++
    this._clock.next()
  }

  get currentTime () {
    return {
      sinceEpoch: this._clock.now,
      vector: this._vectorClock
    }
  }

  joinInitialCluster (addresses) {
    return this._server.join(addresses)
  }
}
