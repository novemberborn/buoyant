import { installClock } from 'lolex'

import { createServer } from '🏠'
import { exposeEvents } from '🏠/lib/expose-events'

export default class Process {
  constructor (address, createTransport) {
    const emitter = exposeEvents(this)

    this._server = createServer({
      address,
      applyEntry: emitter.emit.bind(emitter, 'applyEntry'),
      crashHandler: emitter.emit.bind(emitter, 'crash'),
      createTransport,
      electionTimeoutWindow: [10, 20],
      heartbeatInterval: 5,
      persistEntries: emitter.emit.bind(emitter, 'persistEntries'),
      persistState: emitter.emit.bind(emitter, 'persistState')
    })

    this._currentTime = 0
    this._clock = installClock(this.server._raft.timers, this._currentTime, ['clearInterval', 'setInterval', 'clearTimeout', 'setTimeout'])
    this._raft = this.server._raft
  }

  advanceClock () {
    this._currentTime = this.clock.next()
    return this.idle()
  }

  get currentTime () { return this._currentTime }

  idle () {
    if (!this._raft.currentRole) return Promise.resolve()

    const scheduler = this._raft.currentRole.scheduler
    return new Promise(resolve => scheduler.asap(() => resolve(this.idle()), resolve))
  }
}
