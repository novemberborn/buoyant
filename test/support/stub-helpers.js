import sinon from 'sinon'

export function stubLog () {
  const log = sinon.stub({
    _lastIndex () {},
    get lastIndex () { return this._lastIndex() },
    _lastTerm () {},
    get lastTerm () { return this._lastTerm() },
    commit () {},
    getEntry () {},
    mergeEntries () {}
  })
  log.getEntry.returns(undefined)
  log.mergeEntries.returns(Promise.resolve())
  return log
}

export function stubMessages () {
  const messages = sinon.stub({ canTake () {}, take () {}, await () {} })
  messages.canTake.returns(false)
  messages.take.returns(null)
  messages.await.returns(new Promise(() => {}))
  return messages
}

let peerCount = 0
export function stubPeer () {
  return sinon.stub({ messages: stubMessages(), send () {}, id: ++peerCount })
}

export function stubState () {
  const state = sinon.stub({
    _currentTerm () {},
    get currentTerm () { return this._currentTerm() },
    _votedFor () {},
    get votedFor () { return this._votedFor() },
    nextTerm () {},
    setTerm () {},
    setTermAndVote () {}
  })
  state.nextTerm.returns(Promise.resolve())
  state.setTerm.returns(Promise.resolve())
  state.setTermAndVote.returns(Promise.resolve())
  return state
}
