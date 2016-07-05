import test from 'ava'
import proxyquire from 'proxyquire'
import { stub } from 'sinon'

import dist from './helpers/dist'

// Don't use the Promise introduced by babel-runtime. https://github.com/avajs/ava/issues/947
const { Promise } = global

const shared = {
  MessageBuffer () {},
  Peer () {}
}

const { default: NonPeerReceiver } = proxyquire.noCallThru()(dist('lib/NonPeerReceiver'), {
  './MessageBuffer': function (...args) { return shared.MessageBuffer(...args) },
  './Peer': function (...args) { return shared.Peer(...args) }
})

test.beforeEach(t => {
  const connect = stub().returns(new Promise(() => {}))
  const MessageBuffer = stub()
  const Peer = stub()
  const stream = stub({ read () {} })

  // Note that the next tests' beforeEach hook overrides the shared stubs. Tests
  // where NonPeerReceiver, MessageBuffer or Peer are instantiated
  // asynchronously need to be marked as serial.
  Object.assign(shared, { MessageBuffer, Peer })

  Object.assign(t.context, {
    connect,
    MessageBuffer,
    Peer,
    stream
  })
})

test('create a message buffer', t => {
  const { connect, MessageBuffer, stream } = t.context
  const messages = {}
  MessageBuffer.returns(messages)

  const receiver = new NonPeerReceiver(stream, connect)
  t.true(MessageBuffer.calledOnce)
  const { args: [actualStream] } = MessageBuffer.firstCall
  t.true(actualStream === stream)
  t.true(receiver.messages === messages)
})

test('createPeer() connects to the address', t => {
  const { connect, stream } = t.context
  const receiver = new NonPeerReceiver(stream, connect)
  const peerAddress = Symbol()
  receiver.createPeer(peerAddress)

  t.true(connect.calledOnce)
  const { args: [{ address, writeOnly }] } = connect.firstCall
  t.true(address === peerAddress)
  t.true(writeOnly === true)
})

test.serial('createPeer() returns a promise that is fulfilled with the peer once it’s connected', async t => {
  const { connect, Peer } = t.context
  const peerAddress = Symbol()
  const stream = {}
  connect.returns(Promise.resolve(stream))

  const peer = {}
  Peer.returns(peer)

  const receiver = new NonPeerReceiver(stream, connect)
  t.true(await receiver.createPeer(peerAddress) === peer)
  const { args: [addressForPeer, streamForPeer] } = Peer.lastCall
  t.true(addressForPeer === peerAddress)
  t.true(streamForPeer === stream)
})

test('createPeer() returns a promise that is rejected with the connection failure, if any', async t => {
  const { connect, stream } = t.context
  const err = Symbol()
  connect.returns(Promise.reject(err))

  const receiver = new NonPeerReceiver(stream, connect)
  const reason = await t.throws(receiver.createPeer())
  t.true(reason === err)
})
