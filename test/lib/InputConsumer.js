// https://github.com/avajs/eslint-plugin-ava/issues/127
/* eslint-disable ava/use-t */

import test from 'ava'
import { stub } from 'sinon'

import InputConsumer from 'dist/lib/InputConsumer'

import fork from './helpers/fork-context'
import macro from './helpers/macro'
import { stubMessages, stubPeer } from './helpers/stub-helpers'

// Don't use the Promise introduced by babel-runtime. https://github.com/avajs/ava/issues/947
const { Promise } = global

test.beforeEach(t => {
  const scheduler = stub({ asap () {} })
  scheduler.asap.returns(new Promise(() => {}))

  const peers = [stubPeer(), stubPeer(), stubPeer()]

  const nonPeerReceiver = stub({
    messages: stubMessages(),
    createPeer () {}
  })
  nonPeerReceiver.createPeer.returns(new Promise(() => {}))

  const handlers = {
    message: stub().returns(new Promise(() => {})),
    crash: stub()
  }

  const consumer = new InputConsumer({
    peers,
    nonPeerReceiver,
    scheduler,
    handleMessage (...args) { return handlers.message(...args) },
    crashHandler (...args) { return handlers.crash(...args) }
  })

  Object.assign(t.context, {
    consumer,
    handlers,
    nonPeerReceiver,
    peers,
    scheduler
  })
})
test.always.afterEach(t => t.context.consumer.stop())

const canTakeMessage = fork().beforeEach(t => {
  const { peers } = t.context
  peers[1].messages.canTake.onCall(0).returns(true)
})

const canTakeNonPeerMessage = fork().beforeEach(t => {
  const { nonPeerReceiver } = t.context
  nonPeerReceiver.messages.canTake.onCall(0).returns(true)
  nonPeerReceiver.messages.take.returns([])
})

const crashesConsumer = macro(async (t, setup) => {
  const { consumer, handlers } = t.context

  const err = Symbol()
  setup(err, t.context)

  consumer.start()
  await new Promise(resolve => setImmediate(resolve))

  t.true(handlers.crash.calledOnce)
  const { args: [reason] } = handlers.crash.firstCall
  t.true(reason === err)
}, suffix => `crash the consumer ${suffix}`)

const schedulesMessageHandling = t => {
  const { consumer, scheduler } = t.context
  consumer.start()

  t.true(scheduler.asap.calledOnce)
  const { args: [handleAbort, fn] } = scheduler.asap.firstCall
  t.true(handleAbort === null)
  t.true(typeof fn === 'function')
}

const takesMessageWhenHandleable = (t, getPeer) => {
  const { consumer, scheduler } = t.context
  const peer = getPeer(t.context)
  consumer.start()

  t.true(peer.messages.take.notCalled)
  scheduler.asap.yield()
  t.true(peer.messages.take.calledOnce)
}

const callsHandleMessage = async (t, setupPeer) => {
  const { consumer, handlers, scheduler } = t.context
  const message = Symbol()
  const peer = setupPeer(t.context, message)
  scheduler.asap.onCall(0).yields()
  consumer.start()

  // Allows this macro to be used for non-peer messages, which need to wait
  // for the peer to be created.
  await Promise.resolve()

  t.true(handlers.message.calledOnce)
  const { args: [fromPeer, received] } = handlers.message.firstCall
  t.true(fromPeer === peer)
  t.true(received === message)
}

test('begin message consumption when start() is called', t => {
  const { consumer, peers } = t.context
  t.true(peers[0].messages.canTake.notCalled)

  consumer.start()
  t.true(peers[0].messages.canTake.calledOnce)
})

test('consult each peer in order', t => {
  const { peers, consumer } = t.context
  consumer.start()

  const stubs = peers.map(peer => peer.messages.canTake)
  t.true(stubs[0].calledBefore(stubs[1]))
  t.true(stubs[1].calledBefore(stubs[2]))
})

canTakeMessage.test('once a message can be taken, schedule its handling', schedulesMessageHandling)
canTakeMessage.test('only take a message when it can be handled', takesMessageWhenHandleable, ({ peers }) => peers[1])
canTakeMessage.test('pass the peer and the message to handleMessage()', callsHandleMessage, ({ peers }, message) => {
  peers[1].messages.take.returns(message)
  return peers[1]
})

canTakeMessage.test('do not consult further peers when the scheduler returns a promise', t => {
  const { consumer, scheduler, peers } = t.context
  scheduler.asap.returns(new Promise(() => {}))
  consumer.start()

  t.true(peers[2].messages.canTake.notCalled)
})

canTakeMessage.test('consult the next peer once the scheduler\'s promise fulfils', async t => {
  const { consumer, peers, scheduler } = t.context

  let fulfil
  scheduler.asap.onCall(0).returns(new Promise(resolve => {
    fulfil = resolve
  }))

  consumer.start()
  t.true(peers[0].messages.canTake.calledOnce)
  t.true(peers[1].messages.canTake.calledOnce)
  t.true(peers[2].messages.canTake.notCalled)

  peers[2].messages.canTake.returns(true)
  fulfil()
  await Promise.resolve()

  t.true(peers[0].messages.canTake.calledOnce)
  t.true(peers[1].messages.canTake.calledOnce)
  t.true(peers[2].messages.canTake.calledOnce)
})

canTakeMessage.test('if the scheduler\'s promise rejects', crashesConsumer, (err, { scheduler }) => {
  scheduler.asap.onCall(0).returns(Promise.reject(err))
})

canTakeMessage.test('synchronously consult more peers after a message is handled synchronously', t => {
  const { consumer, peers, scheduler } = t.context
  scheduler.asap.returns()
  peers[0].messages.canTake.onCall(1).returns(true)
  consumer.start()

  const calls = [0, 1].reduce((calls, n) => {
    return calls.concat(peers.map(peer => peer.messages.canTake.getCall(n)))
  }, []).filter(call => call)

  t.true(calls.length === 6)
  t.true(calls[0].calledBefore(calls[1]))
  t.true(calls[1].calledBefore(calls[2]))
  t.true(calls[2].calledBefore(calls[3]))
  t.true(calls[3].calledBefore(calls[4]))
  t.true(calls[4].calledBefore(calls[5]))
})

canTakeMessage.test('if handling a message fails', crashesConsumer, (err, { handlers, peers, scheduler }) => {
  handlers.message.throws(err)
  peers[0].messages.canTake.onCall(0).returns(true)
  peers[0].messages.take.returns(Symbol())
  scheduler.asap.yields()
})

test('consult nonPeerReceiver if no message can be taken from the peers', t => {
  const { consumer, nonPeerReceiver } = t.context
  consumer.start()
  t.true(nonPeerReceiver.messages.canTake.calledOnce)
})

canTakeNonPeerMessage.test('once a non-peer message can be taken, schedule its handling', schedulesMessageHandling)
canTakeNonPeerMessage.test('only take a non-peer message when it can be handled', takesMessageWhenHandleable, ({ nonPeerReceiver }) => nonPeerReceiver)

canTakeNonPeerMessage.test('create a peer to handle a non-peer message', t => {
  const { consumer, nonPeerReceiver, scheduler } = t.context
  const address = Symbol()
  nonPeerReceiver.messages.take.returns([address])
  scheduler.asap.onCall(0).yields()
  consumer.start()

  t.true(nonPeerReceiver.createPeer.calledOnce)
  const { args: [peerAddress] } = nonPeerReceiver.createPeer.firstCall
  t.true(peerAddress === address)
})

canTakeNonPeerMessage.test('pass the created peer and non-peer message to handleMessage()', callsHandleMessage, ({ nonPeerReceiver }, message) => {
  nonPeerReceiver.messages.take.returns([null, message])
  const peer = Symbol()
  nonPeerReceiver.createPeer.returns(Promise.resolve(peer))
  return peer
})

canTakeNonPeerMessage.test('wait for the non-peer message to be handled before consulting further peers', async t => {
  const { consumer, handlers, nonPeerReceiver, peers, scheduler } = t.context
  let fulfil
  handlers.message.returns(new Promise(resolve => {
    fulfil = resolve
  }))
  nonPeerReceiver.createPeer.returns(Promise.resolve())
  scheduler.asap = (_, fn) => fn()
  consumer.start()

  for (const { messages } of peers) {
    t.true(messages.await.notCalled)
  }
  t.true(nonPeerReceiver.messages.await.notCalled)

  fulfil()
  await new Promise(resolve => setImmediate(resolve))

  for (const { messages } of peers) {
    t.true(messages.await.calledOnce)
  }
  t.true(nonPeerReceiver.messages.await.calledOnce)
})

canTakeNonPeerMessage.test('if handling the non-peer message fails', crashesConsumer, (err, { handlers, nonPeerReceiver, scheduler }) => {
  handlers.message.throws(err)
  nonPeerReceiver.createPeer.returns(Promise.resolve())
  scheduler.asap = (_, fn) => fn()
})

canTakeNonPeerMessage.test('if creating the peer for the non-peer message fails', crashesConsumer, (err, { nonPeerReceiver, scheduler }) => {
  nonPeerReceiver.createPeer.returns(Promise.reject(err))
  scheduler.asap = (_, fn) => fn()
})

test('wait for message to become available from any peer or non-peer when no message can be taken otherwise', t => {
  const { consumer, nonPeerReceiver, peers } = t.context
  consumer.start()

  for (const { messages } of peers) {
    t.true(messages.await.calledOnce)
  }
  t.true(nonPeerReceiver.messages.await.calledOnce)
})

test('consult peers after message has become available', async t => {
  const { consumer, peers } = t.context
  let available
  peers[2].messages.await.onCall(0).returns(new Promise(resolve => {
    available = resolve
  }))
  consumer.start()

  // Make a message available for the second peer.
  available()
  await new Promise(resolve => setImmediate(resolve))

  // Each canTake() should be invoked, in order (so first peer goes first).
  // Ignore the first call to canTake().
  const calls = peers.map(peer => peer.messages.canTake.getCall(1))
  t.true(calls[0].calledBefore(calls[1]))
  t.true(calls[1].calledBefore(calls[2]))
})

test('if an error occurs while waiting for messages', crashesConsumer, (err, { peers }) => {
  peers[2].messages.await.onCall(0).returns(Promise.reject(err))
})

test('stop() prevents messages from being consumed after scheduler finishes', async t => {
  const { consumer, peers, scheduler } = t.context
  let finish
  scheduler.asap.onCall(0).returns(new Promise(resolve => {
    finish = resolve
  }))
  peers[0].messages.canTake.returns(true)

  consumer.start()
  consumer.stop()
  finish()
  await new Promise(resolve => setImmediate(resolve))

  t.true(peers[1].messages.canTake.notCalled)
})

test('stop() prevents messages from being consumed when they become available', async t => {
  const { consumer, peers } = t.context
  let available
  peers[2].messages.await.onCall(0).returns(new Promise(resolve => {
    available = resolve
  }))

  consumer.start()
  consumer.stop()
  available()
  await new Promise(resolve => setImmediate(resolve))

  t.true(peers[0].messages.canTake.calledOnce)
})

test('stop() immediately prevents messages from being consumed when called as a side-effect from a synchronous handleMessage() call', t => {
  const { consumer, handlers, peers, scheduler } = t.context
  peers[0].messages.canTake.returns(true)
  scheduler.asap.onCall(0).yields().returns(undefined)
  handlers.message = () => consumer.stop()
  consumer.start()

  t.true(peers[0].messages.canTake.calledOnce)
  t.true(peers[1].messages.canTake.notCalled)
})

test('stop() prevents non-peer message from being handled when called while creating the peer', async t => {
  const { consumer, handlers, nonPeerReceiver, scheduler } = t.context
  scheduler.asap.onCall(0).yields()
  nonPeerReceiver.messages.canTake.returns(true)
  nonPeerReceiver.messages.take.returns([])
  let create
  nonPeerReceiver.createPeer.returns(new Promise(resolve => {
    create = resolve
  }))

  consumer.start()
  t.true(nonPeerReceiver.createPeer.calledOnce)
  consumer.stop()

  create()
  await Promise.resolve()

  t.true(handlers.message.notCalled)
})
