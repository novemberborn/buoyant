import test from 'ava'
import proxyquire from 'proxyquire'
import { spy, stub } from 'sinon'

import dist from './helpers/dist'
import macro from './helpers/macro'

const stubbedProcess = stub({ nextTick () {} })
const { default: exposeEvents } = proxyquire.noCallThru()(dist('lib/expose-events'), {
  './process': stubbedProcess
})

const checkDefinition = macro((t, method) => {
  const target = {}
  exposeEvents(target)

  const { configurable, enumerable, value, writable } = Object.getOwnPropertyDescriptor(target, method)
  t.true(configurable)
  t.false(enumerable)
  t.true(typeof value === 'function')
  t.true(writable)
}, (_, method) => `exposeEvents(target) exposes ${method}() on the target object`)

const propagatesArgs = macro((t, method) => {
  const target = {}
  const stubbed = stub(exposeEvents(target), method)

  const args = [Symbol(), Symbol()]
  target[method](...args)

  t.true(stubbed.calledOnce)
  const { args: propagated } = stubbed.firstCall
  t.deepEqual(propagated, args)
}, (_, method) => `calling target.${method}() propagates the arguments to the emitter`)

const returnsThisArg = macro((t, method) => {
  const target = {}
  stub(exposeEvents(target), method)

  const thisArg = Symbol()
  t.true(target[method].call(thisArg) === thisArg)
}, (_, method) => `calling target.${method}() returns the thisArg`)

const listenerMustBeFunction = macro((t, method) => {
  const emitter = exposeEvents({})
  t.throws(() => emitter[method](Symbol()), TypeError, "Parameter 'listener' must be a function, not undefined")
}, (_, method) => `${method}() must be called with a listener function`)

function setupWithListener (method) {
  const target = {}
  const emitter = exposeEvents(target)
  const event = Symbol()
  const listener = spy()
  emitter[method](event, listener)

  return {
    emit (...args) {
      emitter.emit(event, ...args)
    },
    emitter,
    event,
    listener,
    target
  }
}

const registersListener = macro((t, method) => {
  const { emit, listener } = setupWithListener(method)
  emit()

  t.true(listener.calledOnce)
}, (_, method) => `${method}(event, listener) registers the listener for the event`)

const callsListenerOnTarget = macro((t, method) => {
  const { emit, listener, target } = setupWithListener(method)
  emit()

  const { thisValue } = listener.firstCall
  t.true(thisValue === target)
}, (_, method) => `listener for ${method}() is called on the target object`)

const repeatListenerRegistration = macro((t, method) => {
  const { emit, emitter, event, listener } = setupWithListener(method)
  emitter[method](event, listener)
  emit()

  t.true(listener.calledOnce)
}, (_, method) => `listener is called once even if registered more than once for the same event with ${method}()`)

const multipleListenerRegistration = macro((t, method) => {
  const { emitter, event, listener } = setupWithListener(method)
  const otherEvent = Symbol()
  emitter[method](otherEvent, listener)

  const [first, second] = [Symbol(), Symbol()]
  emitter.emit(event, first)
  emitter.emit(otherEvent, second)

  t.true(listener.calledTwice)
  const { args: [[firstValue], [secondValue]] } = listener
  t.true(firstValue === first)
  t.true(secondValue === second)
}, (_, method) => `listener is called multiple times if registered for multiple events with ${method}()`)

const repeatEmitOfOnListener = macro((t, previous) => {
  const { emit, emitter, event, listener } = setupWithListener(previous || 'on')
  if (previous) {
    emitter[previous === 'on' ? 'once' : 'on'](event, listener)
  }

  ;[Symbol(), Symbol(), Symbol()].forEach((arg, n) => {
    emit(arg)

    t.true(listener.callCount === n + 1)
    const { args: [value] } = listener.getCall(n)
    t.true(value === arg)
  })
}, (_, previous) => {
  const suffixes = {
    '': 'on()',
    on: 'once(), if previously registered with on()',
    once: 'on(), even if previously registered with once()'
  }

  return `listener is called multiple times if registered with ${suffixes[previous]}`
})

const removesListener = macro((t, method) => {
  const { emit, emitter, event, listener } = setupWithListener(method)
  emitter.removeListener(event, listener)
  emit()

  t.true(listener.notCalled)
}, (_, method) => `removeListener(event, listener) removes listener previously registered for event with ${method}()`)

test.always.afterEach(() => {
  stubbedProcess.nextTick.reset()
})

test('exposeEvents() returns an emitter', t => {
  const emitter = exposeEvents({})
  t.true(typeof emitter.emit === 'function')
})

for (const method of ['on', 'once', 'removeListener']) {
  test(checkDefinition, method)
  test(propagatesArgs, method)
  test(returnsThisArg, method)
  test(listenerMustBeFunction, method)
}

for (const method of ['on', 'once']) {
  test(registersListener, method)
  test(callsListenerOnTarget, method)
  test(repeatListenerRegistration, method)
  test(multipleListenerRegistration, method)
  test(removesListener, method)
}

test(repeatEmitOfOnListener, '')
test(repeatEmitOfOnListener, 'on')
test(repeatEmitOfOnListener, 'once')

test('listener is called once if registered with once()', t => {
  const { emit, listener } = setupWithListener('once')
  const first = Symbol()
  ;[first, Symbol(), Symbol()].forEach((arg, n) => {
    emit(arg)
  })

  t.true(listener.calledOnce)
  const { args: [value] } = listener.firstCall
  t.true(value === first)
})

test('once() listeners are called in order of registration', t => {
  const { emit, emitter, event, listener } = setupWithListener('once')
  const otherListener = spy()
  emitter.once(event, otherListener)
  emit()

  t.true(listener.calledBefore(otherListener))
})

test('removeListener(event, listener) has no effect if listener wasn\'t registered for the event', t => {
  const { emitter, event } = setupWithListener('on')
  emitter.removeListener(event, () => {})
  t.pass()
})

test('removeListener(event, listener) has no effect if no listener was registered for the event', t => {
  const { emitter } = setupWithListener('on')
  emitter.removeListener(Symbol(), () => {})
  t.pass()
})

test('removeListener(event, listener) does not remove other listeners', t => {
  const { emit, emitter, event, listener } = setupWithListener('on')
  emitter.removeListener(event, () => {})
  emit()

  t.true(listener.calledOnce)
})

test('call listeners that are added while emitting', t => {
  const { emit, emitter, event } = setupWithListener('on')
  const listener = spy()
  emitter.on(event, () => {
    emitter.on(event, listener)
  })
  emit()

  t.true(listener.calledOnce)
})

test('does not call listeners that are removed while emitting', t => {
  const { emit, emitter, event } = setupWithListener('on')
  const listener = spy()
  emitter.on(event, () => {
    emitter.removeListener(event, listener)
  })
  emitter.on(event, listener)
  emit()

  t.true(listener.notCalled)
})

test('does not call the next listeners if a listener throws', t => {
  const { emit, emitter, event } = setupWithListener('on')
  const listener = spy()
  emitter.on(event, () => {
    throw new Error()
  })
  emitter.on(event, listener)
  emit()

  t.true(listener.notCalled)
})

test('asynchronously rethrows listener errors', t => {
  const { emit, emitter, event } = setupWithListener('on')
  const expected = new Error()
  emitter.on(event, () => {
    throw expected
  })

  t.true(stubbedProcess.nextTick.notCalled)
  emit()
  t.true(stubbedProcess.nextTick.calledOnce)

  const actual = t.throws(() => stubbedProcess.nextTick.yield())
  t.true(actual === expected)
})
