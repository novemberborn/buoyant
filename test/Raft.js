import test from 'ava'
import proxyquire from 'proxyquire'
import { spy, stub } from 'sinon'

import fork from './helpers/fork-context'
import macro from './helpers/macro'
import { stubState } from './helpers/stub-helpers'

// Don't use the Promise introduced by babel-runtime. https://github.com/avajs/ava/issues/947
const { Promise } = global

const shared = {
  Candidate () {},
  Follower () {},
  Leader () {},
  Log () {},
  LogEntryApplier () {},
  NonPeerReceiver () {},
  Peer () {},
  State () {}
}

const { default: Raft } = proxyquire.noCallThru()('../lib/Raft', {
  './Log': function (...args) { return shared.Log(...args) },
  './LogEntryApplier': function (...args) { return shared.LogEntryApplier(...args) },
  './NonPeerReceiver': function (...args) { return shared.NonPeerReceiver(...args) },
  './Peer': function (...args) { return shared.Peer(...args) },
  './roles/Candidate': function (...args) { return shared.Candidate(...args) },
  './roles/Follower': function (...args) { return shared.Follower(...args) },
  './roles/Leader': function (...args) { return shared.Leader(...args) },
  './State': function (...args) { return shared.State(...args) }
})

const destroysCurrentRole = macro((t, method) => {
  const { createRaft, Leader } = t.context
  const raft = createRaft()
  raft.becomeLeader()
  raft[method]()
  const { returnValue: role } = Leader.firstCall
  t.true(role.destroy.calledOnce)
}, (_, method) => `${method}() destroys the current role`)

const propagateToLog = macro((t, method) => {
  const { createRaft } = t.context
  const raft = createRaft()
  const result = Symbol()
  raft.log[method].returns(result)
  t.true(raft[method]() === result)
}, (_, method) => `${method}() calls ${method}() on the log and returns the result`)

const emitsEvent = macro((t, method, event) => {
  const { emitEvent, raft } = t.context
  const currentTerm = Symbol()
  raft.state._currentTerm.returns(currentTerm)

  raft[method]()
  t.true(emitEvent.calledOnce)
  const { args: [emitted, term] } = emitEvent.firstCall
  t.true(emitted === event)
  t.true(term === currentTerm)
}, (_, method, event) => `${method}() emits a ${event} event`)

const doubleChecksEmitEvent = macro((t, method, event) => {
  const { emitEvent, raft } = t.context
  Object.defineProperty(raft, 'currentRole', {
    get () { return this._role || null },
    set (role) {
      this._role = role
      if (role) {
        role.start = () => {
          raft.currentRole = null
        }
      }
    }
  })

  raft[method]()
  t.true(emitEvent.notCalled)
}, (_, method, event) => `${method}() does not emit the ${event} event if the role is changed before it can be emitted`)

const startsRole = macro((t, method) => {
  const { raft } = t.context
  raft[method]()
  t.true(raft.currentRole.start.calledOnce)
}, (_, method, role) => `${method}() starts the ${role}`)

test.beforeEach(t => {
  const Candidate = spy(() => stub({ destroy () {}, start () {} }))
  const Follower = spy(() => stub({ destroy () {}, start () {} }))
  const Leader = spy(() => stub({ destroy () {}, start () {}, append () {} }))

  const Log = spy(() => stub({ replace () {}, close () {}, destroy () {} }))
  const LogEntryApplier = spy(() => stub())
  const State = spy(() => stubState())

  const NonPeerReceiver = spy(() => stub())
  const Peer = spy(() => stub())

  const id = Symbol()
  const electionTimeoutWindow = [1000, 2000]
  const heartbeatInterval = Symbol()
  const persistState = Symbol()
  const persistEntries = Symbol()
  const applyEntry = Symbol()
  const crashHandler = Symbol()
  const emitEvent = spy()

  const createRaft = () => {
    const raft = new Raft({
      applyEntry,
      crashHandler,
      electionTimeoutWindow,
      emitEvent,
      heartbeatInterval,
      id,
      persistEntries,
      persistState
    })
    spy(raft, 'becomeLeader')
    spy(raft, 'convertToCandidate')
    spy(raft, 'convertToFollower')
    return raft
  }

  // Note that the next tests' beforeEach hook overrides the shared stubs. Tests
  // where these classes are instantiated asynchronously need to be marked as
  // serial.
  Object.assign(shared, {
    Candidate,
    Follower,
    Leader,
    Log,
    LogEntryApplier,
    NonPeerReceiver,
    Peer,
    State
  })

  Object.assign(t.context, {
    applyEntry,
    createRaft,
    Candidate,
    crashHandler,
    electionTimeoutWindow,
    emitEvent,
    heartbeatInterval,
    id,
    Follower,
    Leader,
    Log,
    LogEntryApplier,
    NonPeerReceiver,
    Peer,
    persistEntries,
    persistState,
    State
  })
})

const withInstance = fork().beforeEach(t => {
  const { createRaft } = t.context
  t.context.raft = createRaft()
})

const joinInitialCluster = withInstance.fork().beforeEach(t => {
  const addresses = [Symbol(), Symbol()]
  const streams = new Map().set(addresses[0], Symbol()).set(addresses[1], Symbol())
  const connect = spy(({ address }) => Promise.resolve(streams.get(address)))
  const nonPeerStream = Symbol()

  Object.assign(t.context, {
    addresses,
    connect,
    nonPeerStream,
    streams
  })
})

const didJoinInitialCluster = joinInitialCluster.fork({ serial: true }).beforeEach(async t => {
  const { addresses, connect, nonPeerStream, raft } = t.context
  const promise = raft.joinInitialCluster({ addresses, connect, nonPeerStream })
  Object.assign(t.context, { promise })
  await promise
})

test('instantiate the state', t => {
  const { createRaft, persistState, State } = t.context
  const raft = createRaft()

  t.true(State.calledOnce)
  const { args: [actualPersistState], returnValue: state } = State.firstCall
  t.true(actualPersistState === persistState)
  t.true(state === raft.state)
})

test('instantiate the log entry applier', t => {
  const { applyEntry, crashHandler, createRaft, LogEntryApplier } = t.context
  createRaft()

  t.true(LogEntryApplier.calledOnce)
  const { args: [{ applyEntry: actualApplyEntry, crashHandler: actualCrashHandler }] } = LogEntryApplier.firstCall
  t.true(actualApplyEntry === applyEntry)
  t.true(actualCrashHandler === crashHandler)
})

test('instantiate the log', t => {
  const { createRaft, Log, LogEntryApplier, persistEntries } = t.context
  const raft = createRaft()

  t.true(Log.calledOnce)
  const { args: [{ persistEntries: actualPersistEntries, applier }], returnValue: log } = Log.firstCall
  t.true(actualPersistEntries === persistEntries)
  t.true(applier === LogEntryApplier.firstCall.returnValue)
  t.true(log === raft.log)
})

withInstance.test('replace() replaces the state', t => {
  const { raft } = t.context
  const state = Symbol()
  raft.replaceState(state)
  t.true(raft.state.replace.calledOnce)
  const { args: [replaced] } = raft.state.replace.firstCall
  t.true(replaced === state)
})

withInstance.test('replaceLog() replaces the log', t => {
  const { raft } = t.context
  const [entries, lastApplied] = [Symbol(), Symbol()]
  raft.replaceLog(entries, lastApplied)
  t.true(raft.log.replace.calledOnce)
  const { args: [replacedEntries, replacedApplied] } = raft.log.replace.firstCall
  t.true(replacedEntries === entries)
  t.true(replacedApplied === lastApplied)
})

test(destroysCurrentRole, 'close')
test(destroysCurrentRole, 'destroy')

test(propagateToLog, 'close')
test(propagateToLog, 'destroy')

didJoinInitialCluster.test('joinInitialCluster() uses connect() to connect to each address', t => {
  const { addresses, connect } = t.context
  t.true(connect.calledTwice)
  for (let n = 0; n < connect.callCount; n++) {
    const { args: [{ address, writeOnly }] } = connect.getCall(n)
    t.true(address === addresses[n])
    t.true(writeOnly !== true)
  }
})

didJoinInitialCluster.test('joinInitialCluster() instantiates a peer for each address and connected stream', t => {
  const { addresses, Peer, raft, streams } = t.context
  t.true(Peer.calledTwice)
  t.true(raft.peers.length === 2)

  const pending = new Set(addresses)
  for (let n = 0; n < Peer.callCount; n++) {
    const { args: [address, stream], returnValue: peer } = Peer.getCall(n)
    t.true(pending.delete(address))
    t.true(stream === streams.get(address))
    t.true(raft.peers[n] === peer)
  }
  t.true(pending.size === 0)
})

didJoinInitialCluster.test('joinInitialCluster(), after connecting to peers, instantiates a non-peer receiver for the nonPeerStream', t => {
  const { connect, NonPeerReceiver, nonPeerStream, raft } = t.context
  t.true(NonPeerReceiver.calledOnce)
  const { args: [stream, connectFn], returnValue: receiver } = NonPeerReceiver.firstCall
  t.true(stream === nonPeerStream)
  t.true(connectFn === connect)
  t.true(raft.nonPeerReceiver === receiver)
})

didJoinInitialCluster.test('convert to follower after joining initial cluster', t => {
  const { raft } = t.context
  t.true(raft.convertToFollower.calledOnce)
})

didJoinInitialCluster.test('joinInitialCluster() returns a promise that is fulfilled when connected successfully', async t => {
  const { promise } = t.context
  t.true(await promise === undefined)
})

joinInitialCluster.test.serial('joinInitialCluster() does not instantiate a peer if a previous address failed to connect', async t => {
  const { addresses, nonPeerStream, Peer, raft } = t.context
  const connect = stub()
  connect.onCall(0).returns(Promise.reject(new Error()))
  let connectOther
  connect.onCall(1).returns(new Promise(resolve => {
    connectOther = resolve
  }))

  await t.throws(raft.joinInitialCluster({ addresses, connect, nonPeerStream }))

  connectOther()
  await Promise.resolve()
  t.true(Peer.notCalled)
})

joinInitialCluster.test.serial('joinInitialCluster() returns a promise that is rejected with the failure reason, if an address fails to connect', async t => {
  const { addresses, nonPeerStream, raft } = t.context
  const err = new Error()
  const actualErr = await t.throws(raft.joinInitialCluster({ addresses, connect () { return Promise.reject(err) }, nonPeerStream }))
  t.true(actualErr === err)
})

for (const [method, roleAndEvent] of [
  ['becomeLeader', 'leader'],
  ['convertToCandidate', 'candidate'],
  ['convertToFollower', 'follower']
]) {
  withInstance.test(destroysCurrentRole, method)
  withInstance.test(emitsEvent, method, roleAndEvent)
  withInstance.test(doubleChecksEmitEvent, method, roleAndEvent)
  withInstance.test(startsRole, method, roleAndEvent)
}

withInstance.test('becomeLeader() instantiates the leader role', t => {
  const { heartbeatInterval: expectedHeartbeatInterval, Leader, raft } = t.context
  raft.peers = Symbol()
  raft.nonPeerReceiver = Symbol()
  raft.becomeLeader()

  t.true(Leader.calledOnce)
  t.true(raft.currentRole === Leader.firstCall.returnValue)

  const { args: [{ heartbeatInterval, state, log, peers, nonPeerReceiver, crashHandler, convertToCandidate, convertToFollower }] } = Leader.firstCall
  t.true(heartbeatInterval === expectedHeartbeatInterval)
  t.true(state === raft.state)
  t.true(log === raft.log)
  t.true(peers === raft.peers)
  t.true(nonPeerReceiver === raft.nonPeerReceiver)
  t.true(crashHandler === raft.crashHandler)

  convertToCandidate()
  t.true(raft.convertToCandidate.calledOnce)
  t.true(raft.convertToCandidate.calledOn(raft))

  const replayMessage = Symbol()
  convertToFollower(replayMessage)
  t.true(raft.convertToFollower.calledOnce)
  t.true(raft.convertToFollower.calledOn(raft))
  const { args: [messageToReplay] } = raft.convertToFollower.firstCall
  t.true(messageToReplay === replayMessage)
})

withInstance.test('convertToCandidate() instantiates the candidate role', t => {
  const { electionTimeoutWindow, id, Candidate, raft } = t.context
  raft.peers = Symbol()
  raft.nonPeerReceiver = Symbol()
  raft.convertToCandidate()

  t.true(Candidate.calledOnce)
  t.true(raft.currentRole === Candidate.firstCall.returnValue)

  const { args: [{ ourId, electionTimeout, state, log, peers, nonPeerReceiver, crashHandler, convertToFollower, becomeLeader }] } = Candidate.firstCall
  t.true(ourId === id)
  t.true(electionTimeout >= electionTimeoutWindow[0] && electionTimeout < electionTimeoutWindow[1])
  t.true(state === raft.state)
  t.true(log === raft.log)
  t.true(peers === raft.peers)
  t.true(nonPeerReceiver === raft.nonPeerReceiver)
  t.true(crashHandler === raft.crashHandler)

  becomeLeader()
  t.true(raft.becomeLeader.calledOnce)
  t.true(raft.becomeLeader.calledOn(raft))

  const replayMessage = Symbol()
  convertToFollower(replayMessage)
  t.true(raft.convertToFollower.calledOnce)
  t.true(raft.convertToFollower.calledOn(raft))
  const { args: [messageToReplay] } = raft.convertToFollower.firstCall
  t.true(messageToReplay === replayMessage)
})

withInstance.test('convertToFollower() instantiates the follower role', t => {
  const { electionTimeoutWindow, Follower, raft } = t.context
  raft.peers = Symbol()
  raft.nonPeerReceiver = Symbol()
  raft.convertToFollower()

  t.true(Follower.calledOnce)
  t.true(raft.currentRole === Follower.firstCall.returnValue)

  const { args: [{ electionTimeout, state, log, peers, nonPeerReceiver, crashHandler, convertToCandidate }] } = Follower.firstCall
  t.true(electionTimeout >= electionTimeoutWindow[0] && electionTimeout < electionTimeoutWindow[1])
  t.true(state === raft.state)
  t.true(log === raft.log)
  t.true(peers === raft.peers)
  t.true(nonPeerReceiver === raft.nonPeerReceiver)
  t.true(crashHandler === raft.crashHandler)

  convertToCandidate()
  t.true(raft.convertToCandidate.calledOnce)
  t.true(raft.convertToCandidate.calledOn(raft))
})

withInstance.test('convertToFollower() passes on the replayMessage', t => {
  const { raft } = t.context
  const replayMessage = Symbol()
  raft.convertToFollower(replayMessage)
  t.true(raft.currentRole.start.calledOnce)
  const { args: [messageToReplay] } = raft.currentRole.start.firstCall
  t.true(messageToReplay === replayMessage)
})

withInstance.test('append() returns a rejected promise if there is no current role', async t => {
  const { raft } = t.context
  t.throws(raft.append(), Error)
})

withInstance.test('append() returns a rejected promise if there current role has no append() method', async t => {
  const { raft } = t.context
  raft.convertToFollower()
  t.throws(raft.append(), Error)
})

withInstance.test('append() calls append() on the current role with the value and returns the result', t => {
  const { raft } = t.context
  raft.becomeLeader()
  const result = Symbol()
  raft.currentRole.append.returns(result)

  const value = Symbol()
  t.true(raft.append(value) === result)
  const { args: [appended] } = raft.currentRole.append.firstCall
  t.true(appended === value)
})
