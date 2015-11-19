import sinon from 'sinon'

export function stubLog () {
  return sinon.stub({
    _lastIndex () {},
    get lastIndex () { return this._lastIndex() },
    _lastTerm () {},
    get lastTerm () { return this._lastTerm() }
  })
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
    nextTerm () {},
    setTerm () {}
  })
  state.nextTerm.returns(Promise.resolve())
  state.setTerm.returns(Promise.resolve())
  return state
}
