import sinon from 'sinon'

export function stubMessages () {
  const messages = sinon.stub({ canTake () {}, take () {}, await () {} })
  messages.canTake.returns(false)
  messages.take.returns(null)
  messages.await.returns(new Promise(() => {}))
  return messages
}

export function stubPeer () {
  return sinon.stub({ messages: stubMessages(), send () {} })
}
