import test from 'ava'
import { stub } from 'sinon'

import MessageBuffer from '../lib/MessageBuffer'

import fork from './helpers/fork-context'

test.beforeEach(t => {
  const stream = stub({
    read () {},
    once () {}
  })
  stream.read.returns(null)
  const buffer = new MessageBuffer(stream)

  Object.assign(t.context, {
    buffer,
    stream
  })
})

const streamHasMessage = fork().beforeEach(t => {
  const { stream } = t.context
  const message = Symbol()
  stream.read.onCall(0).returns(message)
  Object.assign(t.context, { message })
})

const hasBufferedMessage = streamHasMessage.fork().beforeEach(t => {
  const { buffer, stream } = t.context
  buffer.canTake()
  t.true(stream.read.calledOnce)
})

test('take() reads from the stream', t => {
  const { buffer, stream } = t.context
  const message = Symbol()
  stream.read.onCall(0).returns(message)

  t.true(buffer.take() === message)
  t.true(stream.read.calledOnce)
})

hasBufferedMessage.test('take() returns a buffered message', t => {
  const { buffer, message } = t.context
  t.true(buffer.take() === message)
})

hasBufferedMessage.test('take() reads from the stream after the buffered message is taken', t => {
  const { buffer, message, stream } = t.context
  const another = Symbol()
  stream.read.onCall(1).returns(another)

  t.true(buffer.take() === message)
  t.true(buffer.take() === another)
  t.true(stream.read.calledTwice)
})

test('canTake() reads from the stream if there is no buffered message', t => {
  const { buffer, stream } = t.context
  stream.read.onCall(0).returns(Symbol())
  buffer.canTake()
  t.true(stream.read.calledOnce)
})

test('canTake() returns true if a message was read', t => {
  const { buffer, stream } = t.context
  stream.read.onCall(0).returns(Symbol())
  t.true(buffer.canTake())
})

test('canTake() returns false if a message was read', t => {
  const { buffer } = t.context
  t.false(buffer.canTake())
})

hasBufferedMessage.test('canTake() returns true if there is a buffered message', t => {
  const { buffer } = t.context
  t.true(buffer.canTake())
})

test('await() reads from the stream if there is no buffered message', t => {
  const { buffer, stream } = t.context
  stream.read.onCall(0).returns(Symbol())
  buffer.await()
  t.true(stream.read.calledOnce)
})

streamHasMessage.test('await() returns a fulfilled promise if it reads a message from the stream', async t => {
  const { buffer } = t.context
  t.true(await buffer.await() === undefined)
})

streamHasMessage.test('await() returns the same promise if called multiple times in the same turn', t => {
  const { buffer } = t.context
  t.true(buffer.await() === buffer.await())
})

streamHasMessage.test('await() returns different promises if called in different turns', async t => {
  const { buffer } = t.context
  const promise = buffer.await()
  await promise
  t.true(promise !== buffer.await())
})

test('await() listens for the readable event if it did not read a message from the stream', t => {
  const { buffer, stream } = t.context
  buffer.await()
  t.true(stream.once.calledOnce)
  const { args: [event, listener] } = stream.once.firstCall
  t.true(event === 'readable')
  t.true(typeof listener === 'function')
})

test('await() returns a promise that is fulfilled when the stream emits the readable event', async t => {
  const { buffer, stream } = t.context
  const promise = buffer.await()
  const { args: [, fire] } = stream.once.firstCall

  fire()
  t.true(await promise === undefined)
})
