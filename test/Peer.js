import test from 'ava'
import proxyquire from 'proxyquire'
import { stub } from 'sinon'

const shared = {
  MessageBuffer () {}
}

const { default: Peer } = proxyquire.noCallThru()('../lib/Peer', {
  './MessageBuffer': function (...args) { return shared.MessageBuffer(...args) }
})

test.beforeEach(t => {
  const MessageBuffer = stub()
  const stream = stub({ read () {}, write () {} })

  // Note that the next tests' beforeEach hook overrides the shared stubs. Tests
  // where Peer or MessageBuffer are instantiated asynchronously need to be
  // marked as serial.
  Object.assign(shared, { MessageBuffer })

  Object.assign(t.context, { MessageBuffer, stream })
})

test('set address on the instance', t => {
  const { stream } = t.context
  const address = Symbol()
  t.true(new Peer(address, stream).address === address)
})

test('set the address’ serverId on the instance, as id', t => {
  const { stream } = t.context
  const serverId = Symbol()
  t.true(new Peer({ serverId }, stream).id === serverId)
})

test('create a MessageBuffer instance for the stream', t => {
  const { MessageBuffer, stream: expectedStream } = t.context
  const messages = {}
  MessageBuffer.returns(messages)

  const peer = new Peer({}, expectedStream)
  t.true(MessageBuffer.calledOnce)
  const { args: [stream] } = MessageBuffer.firstCall
  t.true(stream === expectedStream)
  t.true(peer.messages === messages)
})

test('send() writes the message to the stream', t => {
  const { stream } = t.context
  const message = Symbol()
  const peer = new Peer({}, stream)
  peer.send(message)

  t.true(stream.write.calledOnce)
  const { args: [written] } = stream.write.firstCall
  t.true(written === message)
})
