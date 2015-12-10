import { install as installClock } from 'lolex'
import { stub } from 'sinon'

import Timers from '../../lib/Timers'

export function stubLog () {
  const log = stub({
    _lastIndex () {},
    get lastIndex () { return this._lastIndex() },
    _lastTerm () {},
    get lastTerm () { return this._lastTerm() },
    appendValue () {},
    commit () {},
    getEntry () {},
    getTerm () {},
    mergeEntries () {},
    getEntriesSince () {}
  })
  log._lastIndex.returns(0)
  log.getEntry.returns(undefined)
  log.mergeEntries.returns(Promise.resolve())

  log.appendValue.throws(new Error('appendValue() stub must be customized'))
  log.getTerm.throws(new Error('getTerm() stub must be customized'))
  log.getEntriesSince.throws(new Error('getEntriesSince() stub must be customized'))

  return log
}

export function stubMessages () {
  const messages = stub({ canTake () {}, take () {}, await () {} })
  messages.canTake.returns(false)
  messages.take.returns(null)
  messages.await.returns(new Promise(() => {}))
  return messages
}

let peerCount = 0
export function stubPeer () {
  return stub({ messages: stubMessages(), send () {}, id: ++peerCount })
}

export function stubState () {
  const state = stub({
    _currentTerm () {},
    get currentTerm () { return this._currentTerm() },
    _votedFor () {},
    get votedFor () { return this._votedFor() },
    nextTerm () {},
    replace () {},
    setTerm () {},
    setTermAndVote () {}
  })
  state.nextTerm.returns(Promise.resolve())
  state.setTerm.returns(Promise.resolve())
  state.setTermAndVote.returns(Promise.resolve())
  return state
}

export function stubTimers () {
  const timers = new Timers()
  const clock = installClock(timers, 0, ['clearInterval', 'setInterval', 'clearTimeout', 'setTimeout'])
  return { clock, timers }
}
