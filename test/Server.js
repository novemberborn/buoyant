import test from 'ava'
import proxyquire from 'proxyquire'
import { spy, stub } from 'sinon'

import _exposeEvents from '../lib/expose-events'
import Address from '../lib/Address'

import fork from './helpers/fork-context'
import macro from './helpers/macro'

// Don't use the Promise introduced by babel-runtime. https://github.com/avajs/ava/issues/947
const { Promise } = global

const shared = {
  exposeEvents () {},
  Raft () {}
}

const { default: Server } = proxyquire.noCallThru()('../lib/Server', {
  './expose-events': function (...args) { return shared.exposeEvents(...args) },
  './Raft': function (...args) { return shared.Raft(...args) }
})

const checkDefinition = macro((t, field) => {
  const { server } = t.context
  const { configurable, enumerable, value, writable } = Object.getOwnPropertyDescriptor(server, field)
  t.false(configurable)
  t.true(enumerable)
  t.true(value === t.context[field])
  t.false(writable)
}, (_, field) => `set ${field}`)

const propagatesCall = macro((t, method, args = [], otherMethod = method) => {
  const { raft, server } = t.context
  server[method](...args)
  t.true(raft[otherMethod].calledOnce)
  const { args: receivedArgs } = raft[otherMethod].firstCall
  t.deepEqual(receivedArgs, args)
}, (_, method) => `${method}() calls ${method}() on the raft implementation`)

const destroysTransportIfJoined = macro((t, method) => {
  const { createTransport, server } = t.context
  server.join()
  const { returnValue: transport } = createTransport.firstCall

  server[method]()
  t.true(transport.destroy.calledOnce)
}, (_, method) => `${method}() destroys the transport if the server has joined a cluster`)

const onlyDestroysTransportOnce = macro((t, method) => {
  const { createTransport, server } = t.context
  server.join()
  const { returnValue: transport } = createTransport.firstCall

  server[method]()
  t.true(transport.destroy.calledOnce)

  server[method]()
  t.true(transport.destroy.calledOnce)
}, (_, method) => `${method}() only destroys the transport once, even if called multiple times`)

function setupTransportDestroy (context, method) {
  const { raft, server, createTransport } = context
  server.join()
  const { returnValue: transport } = createTransport.firstCall
  raft[method].returns(Promise.resolve())

  return Object.assign({ transport }, context)
}

const handlesTransportDestroyPromise = macro(async (t, method) => {
  const { server, transport } = setupTransportDestroy(t.context, method)
  transport.destroy.returns(Promise.resolve())

  t.true(await server[method]() === undefined)
}, (_, method, pastTense) => `${method}() returns a promise that is fulfilled once the promise returned when destroying the transport is fulfilled, and the raft implementation has ${pastTense}`)

const handlesTransportDestroyVoid = macro(async (t, method) => {
  const { server } = setupTransportDestroy(t.context, method)

  t.true(await server[method]() === undefined)
}, (_, method, pastTense) => `${method}() returns a promise that is fulfilled once the raft implementation is ${pastTense}, if destroying the transport did not result in a promise`)

const handlesTransportDestroyReject = macro(async (t, method) => {
  const { server, transport } = setupTransportDestroy(t.context, method)
  const err = new Error()
  transport.destroy.returns(Promise.reject(err))

  const actualErr = await t.throws(server[method]())
  t.true(actualErr === err)
}, (_, method) => `${method}() returns a promise that, if the promise returned when destroying the transport is rejected, is rejected with that reason`)

const handlesTransportDestroyThrow = macro(async (t, method) => {
  const { server, transport } = setupTransportDestroy(t.context, method)
  const err = new Error()
  transport.destroy.throws(err)

  const actualErr = await t.throws(server[method]())
  t.true(actualErr === err)
}, (_, method) => `${method}() returns a promise that, if an error was thrown while destroying the transport, is rejected with that error`)

const returnsFulfilledPromiseIfNotJoined = macro(async (t, method) => {
  const { server } = t.context
  t.true(await server[method]() === undefined)
}, (infix, method) => `${method}() returns a promise that, ${infix}, is fulfilled`)

const propagatesRejectedPromise = macro(async (t, method) => {
  const { raft, server } = t.context
  const err = new Error()
  raft[method].returns(Promise.reject(err))
  const actualErr = await t.throws(server[method]())
  t.true(actualErr === err)
}, (infix, method) => `${method}() returns a promise that, ${infix}, is rejected with that reason`)

function setupListenFailure (context, setup) {
  const err = new Error()
  setup(context, err)
  return Object.assign({ err }, context)
}

const destroysTransportAfterListenFailure = macro(async (t, setup) => {
  const { server, transport } = setupListenFailure(t.context, setup)
  t.plan(1)
  try {
    await server.join()
  } catch (_) {
    t.true(transport.destroy.calledOnce)
  }
}, condition => `join() destroys the transport if ${condition}`)

const rejectsJoinPromiseWithListenFailure = macro(async (t, setup) => {
  const { err, server } = setupListenFailure(t.context, setup)
  const actualErr = await t.throws(server.join())
  t.true(actualErr === err)
}, condition => `join() returns a promise that, if ${condition}, is rejected with that reason`)

const rejectsJoinPromiseWithListenFailureEvenIfTransportDestroyReject = macro(async (t, setup) => {
  const { err, server, transport } = setupListenFailure(t.context, setup)
  transport.destroy.returns(Promise.reject(new Error()))

  const actualErr = await t.throws(server.join())
  t.true(actualErr === err)
}, condition => `join() returns a promise that, if ${condition}, is rejected with that reason, even if the promise returned when destroying the transport is rejected`)

const rejectsJoinPromiseWithListenFailureEvenIfTransportDestroyThrow = macro(async (t, setup) => {
  const { err, server, transport } = setupListenFailure(t.context, setup)
  transport.destroy.throws(new Error())
  const actualErr = await t.throws(server.join())
  t.true(actualErr === err)
}, condition => `join() returns a promise that, if ${condition}, is rejected with that reason, even if an error was thrown when destroying the transport`)

const rejectsJoinPromiseWithListenFailureEvenIfServerClosed = macro(async (t, setup) => {
  const { err, server } = setupListenFailure(t.context, setup)

  // The handling of the listening failure is asynchronous, meaning
  // the server can be closed between the error occurring and it
  // being handled. Set that up here.
  Promise.resolve().then(() => server.close()).catch(() => {})

  const actualErr = await t.throws(server.join())
  t.true(actualErr === err)
}, condition => `join() returns a promise that, if ${condition}, is rejected with that reason, even if the server was closed in the meantime`)

const rejectsJoinPromiseWithListenFailureEvenIfServerDestroyed = macro(async (t, setup) => {
  const { err, server } = setupListenFailure(t.context, setup)

  // The handling of the listening failure is asynchronous, meaning
  // the server can be closed between the error occurring and it
  // being handled. Set that up here.
  Promise.resolve().then(() => server.destroy()).catch(() => {})

  const actualErr = await t.throws(server.join())
  t.true(actualErr === err)
}, condition => `join() returns a promise that, if ${condition}, is rejected with that reason, even if the server was destroyed in the meantime`)

const joinsClusterOnceListenSucceeds = macro(async (t, setup) => {
  const { raft, server, transport } = t.context
  const nonPeerStream = Symbol()
  setup(transport.listen, nonPeerStream)
  await server.join()

  t.true(raft.joinInitialCluster.calledOnce)
  const { args: [{ addresses, connect, nonPeerStream: receivedNonPeerStream }] } = raft.joinInitialCluster.firstCall
  t.true(Array.isArray(addresses))
  t.true(typeof connect === 'function')
  t.true(receivedNonPeerStream === nonPeerStream)
}, condition => `join() joins the cluster once ${condition}`)

test.beforeEach(t => {
  const exposeEvents = spy((...args) => _exposeEvents(...args))
  const Raft = spy(() => stub({
    replaceState () {},
    replaceLog () {},
    close () {},
    destroy () {},
    joinInitialCluster () {},
    append () {}
  }))

  const createTransport = spy(() => stub({
    listen () {},
    connect () {},
    destroy () {}
  }))

  const id = Symbol()
  const address = Symbol()
  const electionTimeoutWindow = Symbol()
  const heartbeatInterval = Symbol()
  const persistState = Symbol()
  const persistEntries = Symbol()
  const applyEntry = Symbol()
  const crashHandler = Symbol()

  // Proxy createTransport() via a wrapper object, allowing tests to
  // change the implementation even after the server instance was created.
  const createTransportProxy = { createTransport }

  const createServer = () => {
    return new Server({
      address,
      applyEntry,
      crashHandler,
      createTransport (...args) { return createTransportProxy.createTransport(...args) },
      electionTimeoutWindow,
      heartbeatInterval,
      id,
      persistEntries,
      persistState
    })
  }

  // Note that the next tests' beforeEach hook overrides the shared stubs. Tests
  // where these classes are instantiated asynchronously need to be marked as
  // serial.
  Object.assign(shared, {
    exposeEvents,
    Raft
  })

  Object.assign(t.context, {
    address,
    applyEntry,
    crashHandler,
    createServer,
    createTransport,
    createTransportProxy,
    electionTimeoutWindow,
    exposeEvents,
    heartbeatInterval,
    id,
    persistEntries,
    persistState,
    Raft
  })
})

const withInstance = fork().beforeEach(t => {
  const { createServer } = t.context
  const server = createServer()
  const { _raft: raft } = server
  Object.assign(t.context, { raft, server })
})

const withTransport = withInstance.fork().beforeEach(t => {
  const { createTransport, createTransportProxy } = t.context

  // Get a valid transport stub, then change createTransport() to
  // always return that stub.
  const transport = createTransport()
  createTransportProxy.createTransport = stub().returns(transport)
  Object.assign(t.context, { transport })
})

const withConnect = withTransport.fork().beforeEach(async t => {
  const { raft, server } = t.context
  await server.join()

  const { args: [{ connect }] } = raft.joinInitialCluster.firstCall
  Object.assign(t.context, { connect })
})

test('instantiate the raft implementation', t => {
  const { createServer, Raft } = t.context
  createServer()
  t.true(Raft.calledOnce)

  const {
    id: expectedId,
    electionTimeoutWindow: expectedElectionTimeoutWindow,
    heartbeatInterval: expectedHeartbeatInterval,
    persistState: expectedPersistState,
    persistEntries: expectedPersistEntries,
    applyEntry: expectedApplyEntry,
    crashHandler: expectedCrashHandler
  } = t.context
  const { args: [{ id, electionTimeoutWindow, heartbeatInterval, persistState, persistEntries, applyEntry, crashHandler, emitEvent }] } = Raft.firstCall
  t.true(id === expectedId)
  t.true(electionTimeoutWindow === expectedElectionTimeoutWindow)
  t.true(heartbeatInterval === expectedHeartbeatInterval)
  t.true(persistState === expectedPersistState)
  t.true(persistEntries === expectedPersistEntries)
  t.true(applyEntry === expectedApplyEntry)
  t.true(crashHandler === expectedCrashHandler)
  t.true(typeof emitEvent === 'function')
})

withInstance.test('remits events from the raft implementation', async t => {
  const { server, Raft } = t.context
  const listener = spy()
  const event = Symbol()
  server.on(event, listener)

  const { args: [{ emitEvent }] } = Raft.firstCall

  const args = [Symbol(), Symbol()]
  emitEvent(event, ...args)

  await Promise.resolve()
  t.true(listener.calledOnce)
  const { args: receivedArgs } = listener.firstCall
  t.deepEqual(receivedArgs, args)
})

test('expose events', t => {
  const { createServer, exposeEvents } = t.context
  const server = createServer()
  t.true(exposeEvents.calledOnce)
  const { args: [context] } = exposeEvents.firstCall
  t.true(context === server)
})

withInstance.test(checkDefinition, 'id')
withInstance.test(checkDefinition, 'address')

withInstance.test('restoreState() throws once the server has joined a cluster', t => {
  const { server } = t.context
  server.join()
  t.throws(() => server.restoreState(), Error, 'Restoring state is no longer allowed')
})

withInstance.test(propagatesCall, 'restoreState', [Symbol()], 'replaceState')

withInstance.test('restoreLog() throws once the server has joined a cluster', t => {
  const { server } = t.context
  server.join()
  t.throws(() => server.restoreLog(), Error, 'Restoring log is no longer allowed')
})

withInstance.test(propagatesCall, 'restoreLog', [Symbol(), Symbol()], 'replaceLog')

for (const [method, pastTense] of [['close', 'closed'], ['destroy', 'destroyed']]) {
  withInstance.test(propagatesCall, method)
  withInstance.test(destroysTransportIfJoined, method)
  withInstance.test(onlyDestroysTransportOnce, method)
  withInstance.test(handlesTransportDestroyPromise, method, pastTense)
  withInstance.test(handlesTransportDestroyVoid, method, pastTense)
  withInstance.test(handlesTransportDestroyReject, method)
  withInstance.test(handlesTransportDestroyThrow, method)
  withInstance.test('if there was no transport to destroy', returnsFulfilledPromiseIfNotJoined, method)
  withInstance.test(`if the raft implementation failed to ${method}`, propagatesRejectedPromise, method)
}

withInstance.test('close() returns the same promise if called multiple times', t => {
  const { server } = t.context
  t.true(server.close() === server.close())
})

withInstance.test('close(), if called after destroy(), returns the promise that was last returned by destroy()', t => {
  const { server } = t.context
  t.true(server.destroy() === server.close())
})

withInstance.test('destroy() returns a different promise if called multiple times', t => {
  const { server } = t.context
  t.true(server.destroy() !== server.destroy())
})

withInstance.test('destroy(), if called after close(), returns a different promise than was last returned by close()', t => {
  const { server } = t.context
  t.true(server.close() !== server.destroy())
})

withInstance.test('join() creates Address instances if necessary', async t => {
  const { raft, server } = t.context
  await server.join(['///first', '///second'])

  const { args: [{ addresses }] } = raft.joinInitialCluster.firstCall
  t.true(addresses.length === 2)
  t.true(addresses[0].serverId === 'first')
  t.true(addresses[1].serverId === 'second')
})

withInstance.test('join() returns a rejected promise if an invalid address is encountered', async t => {
  const { server } = t.context
  await t.throws(server.join(['invalid']), TypeError)
})

withInstance.test('join() uses provided Address instances as-is', async t => {
  const { raft, server } = t.context
  const address = new Address('///foo')
  await server.join([address])

  const { args: [{ addresses }] } = raft.joinInitialCluster.firstCall
  t.true(addresses.length === 1)
  t.true(addresses[0] === address)
})

withInstance.test('join() joins an empty cluster if no addresses were provided', async t => {
  const { raft, server } = t.context
  await server.join()

  const { args: [{ addresses }] } = raft.joinInitialCluster.firstCall
  t.true(addresses.length === 0)
})

withInstance.test('join() returns a rejected promise if the server already joined a cluster', async t => {
  const { server } = t.context
  server.join()
  await t.throws(server.join(), Error, 'Joining a cluster is no longer allowed')
})

withInstance.test('join() returns a rejected promise if the server was already closed', async t => {
  const { server } = t.context
  server.close()
  await t.throws(server.join(), Error, 'Server is closed')
})

withInstance.test('join() returns a rejected promise if the server was already destroyed', async t => {
  const { server } = t.context
  server.destroy()
  await t.throws(server.join(), Error, 'Server is closed')
})

withInstance.test('join() creates the transport', t => {
  const { address, createTransport, server } = t.context
  server.join()
  t.true(createTransport.calledOnce)
  const { args: [actualAddress] } = createTransport.firstCall
  t.true(actualAddress === address)
})

withInstance.test('join() calls listen() on the transport after it’s created', t => {
  const { createTransport, server } = t.context
  server.join()
  const { returnValue: transport } = createTransport.firstCall
  t.true(transport.listen.calledOnce)
})

for (const [condition, setup] of [
  ['the transport’s listen() throws', ({ transport }, err) => transport.listen.throws(err)],
  ['the transport’s listen() returns a rejected promise', ({ transport }, err) => transport.listen.returns(Promise.reject(err))],
  ['joining the cluster fails', ({ raft }, err) => raft.joinInitialCluster.returns(Promise.reject(err))]
]) {
  withTransport.test(condition, destroysTransportAfterListenFailure, setup)
  withTransport.test(condition, rejectsJoinPromiseWithListenFailure, setup)
  withTransport.test(condition, rejectsJoinPromiseWithListenFailureEvenIfTransportDestroyReject, setup)
  withTransport.test(condition, rejectsJoinPromiseWithListenFailureEvenIfTransportDestroyThrow, setup)
  withTransport.test(condition, rejectsJoinPromiseWithListenFailureEvenIfServerClosed, setup)
  withTransport.test(condition, rejectsJoinPromiseWithListenFailureEvenIfServerDestroyed, setup)
}

for (const [condition, setup] of [
  ['the tranport’s listen() returns a promise fulfilled with the nonPeerStream', (listen, nonPeerStream) => listen.returns(Promise.resolve(nonPeerStream))],
  ['the tranport’s listen() returns the nonPeerStream', (listen, nonPeerStream) => listen.returns(nonPeerStream)]
]) {
  withTransport.test(condition, joinsClusterOnceListenSucceeds, setup)
}

withInstance.test('join() returns a fulfilled promise if it successfully joins the cluster', async t => {
  const { server } = t.context
  t.true(await server.join() === undefined)
})

withConnect.test('join() provides a connect() method when joining the cluster, which calls the transport’s connect()', async t => {
  const { connect, transport } = t.context
  const opts = Symbol()
  connect(opts)
  t.true(transport.connect.calledOnce)
  const { args: [receivedOpts] } = transport.connect.firstCall
  t.true(receivedOpts === opts)
})

withConnect.test('join() provides a connect() method when joining the cluster, which returns a promise that is fulfilled when the transport’s connect() returns a fulfilled promise', async t => {
  const { connect, transport } = t.context
  const result = Symbol()
  transport.connect.returns(Promise.resolve(result))
  t.true(await connect() === result)
})

withConnect.test('join() provides a connect() method when joining the cluster, which returns a promise that is fulfilled when the transport’s connect() returns', async t => {
  const { connect, transport } = t.context
  const result = Symbol()
  transport.connect.returns(result)
  t.true(await connect() === result)
})

withConnect.test('join() provides a connect() method when joining the cluster, which returns a promise that is rejected when the transport’s connect() returns a rejected promise', async t => {
  const { connect, transport } = t.context
  const err = new Error()
  transport.connect.returns(Promise.reject(err))
  const actualErr = await t.throws(connect())
  t.true(actualErr === err)
})

withConnect.test('join() provides a connect() method when joining the cluster, which returns a promise that is rejected when the transport’s connect() throws', async t => {
  const { connect, transport } = t.context
  const err = new Error()
  transport.connect.throws(err)
  const actualErr = await t.throws(connect())
  t.true(actualErr === err)
})

withInstance.test('append() calls append() on the raft implementation', t => {
  const { raft, server } = t.context
  const result = Symbol()
  raft.append.returns(result)
  const value = Symbol()
  t.true(server.append(value) === result)
  t.true(raft.append.calledOnce)
  const { args: [appended] } = raft.append.firstCall
  t.true(appended === value)
})
