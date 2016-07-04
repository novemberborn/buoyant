import test from 'ava'
import proxyquire from 'proxyquire'
import { spy, stub } from 'sinon'

import {
  AppendEntries, AcceptEntries, RejectEntries,
  RequestVote, DenyVote, GrantVote,
  Noop
} from 'dist/lib/symbols'
import Address from 'dist/lib/Address'
import Entry from 'dist/lib/Entry'

import dist from './helpers/dist'
import macro from './helpers/macro'

// Don't use the Promise introduced by babel-runtime. https://github.com/avajs/ava/issues/947
const { Promise } = global

const shared = {
  Server () {}
}

const main = proxyquire.noCallThru()(dist('main'), {
  './lib/Server': function (...args) { return shared.Server(...args) }
})

const throwsTypeError = macro((t, param, value, message) => {
  const { createServer } = t.context
  t.throws(() => createServer({ [param]: value }), TypeError, message)
}, (condition, param) => `createServer() throws a TypeError if the ${param} param is ${condition}`)

const usingParam = macro((t, param, value) => {
  const { createServer, Server } = t.context
  createServer({ [param]: value })
  t.true(Server.calledOnce)
  const { args: [{ [param]: used }] } = Server.firstCall
  t.true(used === value)
}, (condition, param) => `createServer() creates a server using the ${param} param ${condition}`.trim())

const usingWrapper = macro((t, param) => {
  const { createServer, Server } = t.context
  createServer({ [param] () {} })
  t.true(Server.calledOnce)
  const { args: [{ [param]: wrapper }] } = Server.firstCall
  t.true(typeof wrapper === 'function')
}, (_, param) => `createServer() creates a server with a Promise-wrapper for the ${param} param`)

function setupWrapper (context, param) {
  const { createServer, Server } = context
  const original = stub()
  createServer({ [param]: original })
  const { args: [{ [param]: wrapper }] } = Server.firstCall
  return Object.assign({ original, wrapper }, context)
}

const wrapperPropagatesToOriginal = macro((t, param) => {
  const { original, wrapper } = setupWrapper(t.context, param)
  const args = Array.from(wrapper, () => Symbol())
  wrapper(...args)

  t.true(original.calledOnce)
  const { args: propagated } = original.firstCall
  t.deepEqual(propagated, args)
}, (_, param) => `the Promise-wrapper for the ${param} param propagates to the original function`)

const wrapperFulfilsLikeOriginal = macro(async (t, param) => {
  const { original, wrapper } = setupWrapper(t.context, param)
  const value = Symbol()
  original.returns(Promise.resolve(value))
  t.true(await wrapper() === value)
}, (_, param) => `the Promise-wrapper for the ${param} param returns a promise that is fulfilled with the value of a promise returned by the original function`)

const wrapperRejectsLikeOriginal = macro(async (t, param) => {
  const { original, wrapper } = setupWrapper(t.context, param)
  const err = new Error()
  original.returns(Promise.reject(err))
  const actualErr = await t.throws(wrapper())
  t.true(actualErr === err)
}, (_, param) => `the Promise-wrapper for the ${param} param returns a promise that is rejected with the reason of a promise returned by the original function`)

const wrapperFulfilsWithOriginalResult = macro(async (t, param) => {
  const { original, wrapper } = setupWrapper(t.context, param)
  const value = Symbol()
  original.returns(value)
  t.true(await wrapper() === value)
}, (_, param) => `the Promise-wrapper for the ${param} param returns a promise that is fulfilled with the value returned by the original function`)

const wrapperRejectsWithOriginalException = macro(async (t, param) => {
  const { original, wrapper } = setupWrapper(t.context, param)
  const err = new Error()
  original.throws(err)
  const actualErr = await t.throws(wrapper())
  t.true(actualErr === err)
}, (_, param) => `the Promise-wrapper for the ${param} param returns a promise that is rejected with the exception thrown by the original function`)

test.beforeEach(t => {
  const Server = spy(() => stub())

  const createServer = opts => {
    return main.createServer(Object.assign({
      address: '///id',
      electionTimeoutWindow: [1000, 2000],
      heartbeatInterval: 500,
      createTransport () {},
      persistState () {},
      persistEntries () {},
      applyEntry () {},
      crashHandler () {}
    }, opts))
  }

  // Note that the next tests' beforeEach hook overrides the shared Server stub.
  // Tests where the Server is instantiated asynchronously need to be marked as
  // serial.
  Object.assign(shared, { Server })

  Object.assign(t.context, {
    createServer,
    Server
  })
})

test('export symbols', t => {
  t.deepEqual(main.symbols, {
    AppendEntries, AcceptEntries, RejectEntries,
    RequestVote, DenyVote, GrantVote,
    Noop
  })
})

test('export Address', t => {
  t.true(main.Address === Address)
})

test('export Entry', t => {
  t.true(main.Entry === Entry)
})

{
  const message = "Parameter 'address' must be a string or an Address instance"
  test('an invalid address string', throwsTypeError, 'address', '🙈', message)
  test('not a string or an Address instance', throwsTypeError, 'address', 42, message)
}

test('createServer() creates the server with an Address instance if the address param is a valid address string', t => {
  const { createServer, Server } = t.context
  createServer({ address: '///foo' })
  t.true(Server.calledOnce)
  const { args: [{ address }] } = Server.firstCall
  t.true(address instanceof Address)
  t.true(address.serverId === 'foo')
})

test('if it is an Address instance', usingParam, 'address', new Address('///foo'))

test('createServer() creates a server whose id is the serverId of the address', t => {
  const { createServer, Server } = t.context
  const address = new Address('///foo')
  createServer({ address })
  t.true(Server.calledOnce)
  const { args: [{ id }] } = Server.firstCall
  t.true(id === address.serverId)
})

for (const [condition, value, message] of [
  ['not iterable', true, "Parameter 'electionTimeoutWindow' must be iterable"],
  ...[
    ['not an integer', '🙈', "Values of parameter 'electionTimeoutWindow' must be integers"],
    ['less than zero', -1, "First value of parameter 'electionTimeoutWindow' must be greater than zero"],
    ['0', 0, "First value of parameter 'electionTimeoutWindow' must be greater than zero"],
    ['larger than the second value', 11, "Second value of parameter 'electionTimeoutWindow' must be greater than the first"],
    ['equal to the second value', 10, "Second value of parameter 'electionTimeoutWindow' must be greater than the first"]
  ].map(([condition, value, message]) => [`an iterable whose first value is ${condition}`, [value, 10], message]),
  ['an iterable whose second value is not an integer', '🙈', "Values of parameter 'electionTimeoutWindow' must be integers"]
]) {
  test(condition, throwsTypeError, 'electionTimeoutWindow', value, message)
}

test(usingParam, 'electionTimeoutWindow', [10, 20])

for (const [condition, value, message] of [
  ['not an integer', '🙈'],
  ['less than zero', -1],
  ['0', 0]
]) {
  test(condition, throwsTypeError, 'heartbeatInterval', value, message)
}

test(usingParam, 'heartbeatInterval', 5)

for (const param of [
  'createTransport',
  'persistState',
  'persistEntries',
  'applyEntry',
  'crashHandler'
]) {
  test('not a function', throwsTypeError, param, 42, `Parameter '${param}' must be a function, not number`)
}

test(usingParam, 'createTransport', () => {})
test(usingParam, 'crashHandler', () => {})

for (const param of ['applyEntry', 'persistEntries', 'persistState']) {
  test(usingWrapper, param)
  test(wrapperPropagatesToOriginal, param)
  test(wrapperFulfilsLikeOriginal, param)
  test(wrapperRejectsLikeOriginal, param)
  test(wrapperFulfilsWithOriginalResult, param)
  test(wrapperRejectsWithOriginalException, param)
}
