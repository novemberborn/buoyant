import test from 'ava'
import { spy, stub } from 'sinon'

import {
  AppendEntries, RejectEntries, AcceptEntries,
  RequestVote, DenyVote,
  Noop
} from 'dist/lib/symbols'

import Entry from 'dist/lib/Entry'

import dist from './helpers/dist'
import fork from './helpers/fork-context'
import macro from './helpers/macro'
import {
  setupConstructors,
  testFollowerConversion,
  testInputConsumerDestruction, testInputConsumerInstantiation, testInputConsumerStart,
  testMessageHandlerMapping,
  testSchedulerDestruction, testSchedulerInstantiation
} from './helpers/role-tests'
import { stubLog, stubMessages, stubPeer, stubState, stubTimers } from './helpers/stub-helpers'

// Don't use the Promise introduced by babel-runtime. https://github.com/avajs/ava/issues/947
const { Promise } = global

const Leader = setupConstructors(dist('lib/roles/Leader'))

function wasHeartbeat (t, call, { prevLogIndex: expectedPrevLogIndex, leaderCommit: expectedLeaderCommit }) {
  const { args: [{ type, term, prevLogIndex, prevLogTerm, leaderCommit, entries }] } = call
  t.true(type === AppendEntries)
  t.true(term === 2)
  t.true(prevLogIndex === expectedPrevLogIndex)
  t.deepEqual(prevLogTerm, { index: expectedPrevLogIndex })
  t.true(leaderCommit === expectedLeaderCommit)
  t.deepEqual(entries, [])
}

function wasEntries (t, call, { prevLogIndex: expectedPrevLogIndex, leaderCommit: expectedLeaderCommit, entryIndexes }) {
  const { args: [{ type, term, prevLogIndex, prevLogTerm, leaderCommit, entries }] } = call
  t.true(type === AppendEntries)
  t.true(term === 2)
  t.true(prevLogIndex === expectedPrevLogIndex)
  t.deepEqual(prevLogTerm, { index: expectedPrevLogIndex })
  t.true(leaderCommit === expectedLeaderCommit)
  t.deepEqual(entries, entryIndexes)
}

const usesScheduler = macro((t, method) => {
  const { leader } = t.context
  // Only checks whether the scheduler is used. Not a perfect test since
  // it doesn't confirm that the operation is actually gated by the
  // scheduler.
  spy(leader.scheduler, 'asap')
  leader[method]()
  t.true(leader.scheduler.asap.calledOnce)
}, (_, method) => `${method}() uses the scheduler`)

const rejectEntriesDoesNotRespond = macro((t, conflictingIndex) => {
  const { leader, peers: [follower] } = t.context
  leader.handleRejectEntries(follower, 1, { conflictingIndex })
  t.true(follower.send.notCalled)
}, condition => `handleRejectEntries() does not send an AppendEntries message to the peer if the conflictingIndex is ${condition}`)

test.beforeEach(t => {
  const convertToCandidate = stub()
  const convertToFollower = stub()
  const crashHandler = stub()
  const heartbeatInterval = 10
  const log = stubLog()
  const nonPeerReceiver = stub({ messages: stubMessages() })
  const peers = [stubPeer(), stubPeer(), stubPeer()]
  const state = stubState()

  const { clock, timers } = stubTimers()

  // Prime the log so nextIndex from each peer is initially divergent from its
  // matchIndex.
  log._lastIndex.returns(2)

  // Return an object so it's easier to verify prevLogTerm is correct in
  // AppendEntries messages.
  log.getTerm = index => ({ index })

  // Return a list of indexes, up to the last index in the log.
  log.getEntriesSince = index => {
    const list = []
    for (let last = log.lastIndex; index <= last; index++) {
      list.push(index)
    }
    return list
  }

  // Set the currentTerm for the leader.
  state._currentTerm.returns(2)

  const leader = new Leader({
    convertToCandidate,
    convertToFollower,
    crashHandler,
    heartbeatInterval,
    log,
    nonPeerReceiver,
    peers,
    state,
    timers
  })
  spy(leader, 'markReplication')

  Object.assign(t.context, {
    clock,
    convertToCandidate,
    convertToFollower,
    crashHandler,
    heartbeatInterval,
    leader,
    log,
    nonPeerReceiver,
    peers,
    state
  })
})

test.afterEach(t => {
  const { leader } = t.context
  leader.pendingApplication = [] // Avoid unhandled rejections
  if (!leader.destroyed) leader.destroy()
})

const beforeRejectEntries = fork().beforeEach(t => {
  const { leader, log, peers: [follower] } = t.context
  // The log was initialized with a last index of 2. This gives an initial
  // matchIndex for each peer of 0, and nextIndex of 3. For testing purposes
  // the first peer should converge.

  // First pretend to append another entry. This allows converging the peer
  // on that entry.
  log._lastIndex.returns(3)
  // Next pretend to accept these entries. This sets the matchIndex to 3 and
  // the nextIndex to 4.
  leader.handleAcceptEntries(follower, 1, { lastLogIndex: 3 })

  Object.assign(t.context, { follower })
})

const canAppend = fork().beforeEach(t => {
  const { leader, log } = t.context

  // Stub correct appendValue() behavior.
  log.appendValue = (_, value) => {
    const index = log.lastIndex + 1
    // Ensure the log's last index reflects the correct value.
    log._lastIndex.returns(index)
    return Promise.resolve(new Entry(index, 1, value))
  }

  // The appendValue() behavior will ensure the internal leader state is
  // in the correct order. The scheduler's behavior is unnecessary so yield
  // immediately.
  stub(leader.scheduler, 'asap').callsArg(1)

  // Stub correct commit() behavior.
  log.commit = spy(index => {
    const appended = appendedValues.find(({ index: entryIndex }) => entryIndex === index)
    return appended ? Promise.resolve(appended.value) : Promise.reject(new Error(`Can't find appended value for index ${index}`))
  })

  // Hold the appended values, their indexes and the promise for when
  // they're committed.
  const appendedValues = []

  const leaderAppend = async values => {
    for (const value of values) {
      const promise = leader.append(value)
      promise.catch(() => { /* ignore */ })
      appendedValues.push({
        value,
        promise,
        index: log.lastIndex
      })
    }

    // Wait for the internal leader state to be updated.
    await Promise.resolve()
  }

  Object.assign(t.context, { appendedValues, leaderAppend })
})

const beforeMarkReplication = canAppend.fork().beforeEach(async t => {
  const { leaderAppend } = t.context
  // Set up three entries that need to be marked as replicated.
  await leaderAppend([Symbol('first'), Symbol('second'), Symbol('third')])
})

const afterAppend = canAppend.fork().beforeEach(async t => {
  const { leader, leaderAppend, peers } = t.context

  // The peers still have an initial matchIndex of 0, and nextIndex of 3.
  // Converge so nextIndex is 1.
  for (const peer of peers) {
    leader.handleRejectEntries(peer, 1, { conflictingIndex: 1 })
    peer.send.reset()
  }
  await leaderAppend([Symbol()])
})

testInputConsumerInstantiation('leader')
testSchedulerInstantiation('leader')

test('start() starts the heartbeat timer', t => {
  const { clock, heartbeatInterval, leader } = t.context
  spy(leader, 'sendHeartbeat')
  leader.start()

  clock.tick(heartbeatInterval)
  t.true(leader.sendHeartbeat.calledOnce)

  clock.tick(heartbeatInterval)
  t.true(leader.sendHeartbeat.calledTwice)
})

test('start() appends a Noop entry', t => {
  const { leader } = t.context
  spy(leader, 'append')
  leader.start()

  t.true(leader.append.calledOnce)
  const { args: [value] } = leader.append.firstCall
  t.true(value === Noop)
})

testInputConsumerStart('leader')

test('destroy() clears the heartbeat timer', t => {
  const { clock, heartbeatInterval, leader } = t.context
  spy(leader, 'sendHeartbeat') // spy on the method called by the timer

  leader.start()
  leader.destroy() // should prevent the timer from triggering
  clock.tick(heartbeatInterval) // timer should fire now, if not cleared
  t.true(leader.sendHeartbeat.notCalled) // should not be called
})

testInputConsumerDestruction('leader')
testSchedulerDestruction('leader')

test(usesScheduler, 'sendHeartbeat')

test('sendHeartbeat() does not schedule again if already scheduled', t => {
  const { leader } = t.context
  const asap = stub(leader.scheduler, 'asap')
  leader.sendHeartbeat()
  t.true(asap.calledOnce)

  leader.sendHeartbeat()
  t.true(asap.calledOnce)
})

test('sendHeartbeat() does schedule again once run', t => {
  const { leader } = t.context
  const asap = stub(leader.scheduler, 'asap')
  leader.sendHeartbeat()
  asap.firstCall.yield()

  leader.sendHeartbeat()
  t.true(asap.calledTwice)
})

test('sendHeartbeat() sends a heartbeat message to each follower', t => {
  const { leader, peers } = t.context
  leader.sendHeartbeat()

  for (const peer of peers) {
    t.true(peer.send.calledOnce)
    wasHeartbeat(t, peer.send.firstCall, { prevLogIndex: 2, leaderCommit: 0 })
  }
})

testFollowerConversion('leader')

testMessageHandlerMapping('leader', [
  { type: RequestVote, label: 'RequestVote', method: 'handleRequestVote' },
  { type: RejectEntries, label: 'RejectEntries', method: 'handleRejectEntries' },
  { type: AcceptEntries, label: 'AcceptEntries', method: 'handleAcceptEntries' }
])

test('handleRequestVote() sends a DenyVote message to the candidate, if its term is older', t => {
  const { leader, peers: [candidate] } = t.context
  leader.handleRequestVote(candidate, 1, { term: 1 })

  t.true(candidate.send.calledOnce)
  const { args: [denied] } = candidate.send.firstCall
  t.deepEqual(denied, { type: DenyVote, term: 2 })
})

test('handleRequestVote() does not send an AppendEntries message to the candidate, if its term is older', t => {
  const { leader, peers: [candidate] } = t.context
  leader.handleRequestVote(candidate, 1, { term: 1 })

  t.true(candidate.send.calledOnce)
  const { args: [{ type }] } = candidate.send.firstCall
  t.true(type !== AppendEntries)
})

test('handleRequestVote() sends a heartbeat message to the candidate if its a known peer whose term is current', t => {
  const { leader, peers: [candidate] } = t.context
  leader.handleRequestVote(candidate, 2, { term: 2 })
  t.true(candidate.send.calledOnce)
  wasHeartbeat(t, candidate.send.firstCall, { prevLogIndex: 2, leaderCommit: 0 })
})

test('handleRequestVote() does not send a heartbeat message to the candidate if its not a known peer', t => {
  const { leader } = t.context
  const peer = stubPeer()
  leader.handleRequestVote(peer, 2, { term: 2 })
  t.true(peer.send.notCalled)
})

beforeRejectEntries.test('handleRejectEntries() does not send an AppendEntries message to an unknown peer', t => {
  const { leader } = t.context
  const peer = stubPeer()
  leader.handleRejectEntries(peer, 1, {})
  t.true(peer.send.notCalled)
})

for (const [condition, conflictingIndex] of [
  ['equal to the matchIndex', 3],
  ['less than the matchIndex', 2],
  ['equal to the nextIndex', 4],
  ['greater than the nextIndex', 5]
]) {
  beforeRejectEntries.test(condition, rejectEntriesDoesNotRespond, conflictingIndex)
}

beforeRejectEntries.test('handleRejectEntries() sends a heartbeat message to the peer if the conflictingIndex is greater than the matchIndex for the peer, and less than the nextIndex for the peer', t => {
  const { leader, peers } = t.context
  // The second peer still has the initial matchIndex of 0, and
  // nextIndex of 3.
  leader.handleRejectEntries(peers[1], 1, { conflictingIndex: 1 })

  t.true(peers[1].send.calledOnce)
  wasHeartbeat(t, peers[1].send.firstCall, { prevLogIndex: 0, leaderCommit: 0 })
})

beforeRejectEntries.test('handleRejectEntries() sets the nextIndex for the peer to the conflictingIndex value, if it is greater than the matchIndex for the peer, and less than the nextIndex for the peer', t => {
  const { leader, peers } = t.context
  // The second peer still has the initial matchIndex of 0, and
  // nextIndex of 3.
  leader.handleRejectEntries(peers[1], 1, { conflictingIndex: 1 })

  // If the same conflictingIndex is received it must now equal the
  // nextIndex for the peer, which means no AppendEntries message should
  // be sent as a result.
  peers[1].send.reset()
  leader.handleRejectEntries(peers[1], 1, { conflictingIndex: 1 })
  t.true(peers[1].send.notCalled)
})

test('handleAcceptEntries() ignores unknown peers', t => {
  const { leader } = t.context
  t.notThrows(() => leader.handleAcceptEntries(stubPeer(), 1, {}))
})

test('handleAcceptEntries() marks replication for entries in the range if lastLogIndex is equal to, or greater than, the nextIndex for the follower', t => {
  const { leader, peers: [follower] } = t.context
  leader.handleAcceptEntries(follower, 1, { lastLogIndex: 3 })
  t.true(leader.markReplication.calledOnce)
  const { args: [start, end] } = leader.markReplication.firstCall
  t.true(start === 3)
  t.true(end === 3)
})

test('handleAcceptEntries() updates nextIndex for the follower if lastLogIndex is equal to, or greater than, the nextIndex for the follower', t => {
  const { leader, peers: [follower] } = t.context
  // nextIndex should be set to lastLogIndex + 1. If that's the case
  // then accepting the same lastLogIndex a second time should not
  // result in any entries being marked as replicated again.
  leader.handleAcceptEntries(follower, 1, { lastLogIndex: 3 })
  t.true(leader.markReplication.calledOnce)

  leader.handleAcceptEntries(follower, 1, { lastLogIndex: 3 })
  t.true(leader.markReplication.calledOnce)
})

test('handleAcceptEntries() updates matchIndex for the follower if lastLogIndex is equal to, or greater than, the nextIndex for the follower', t => {
  const { leader, peers: [follower] } = t.context
  // matchIndex should be set to lastLogIndex. If that's the case then
  // rejecting an earlier lastLogTerm should not result in an
  // AppendEntries message being sent to the follower.
  leader.handleAcceptEntries(follower, 1, { lastLogIndex: 3 })
  follower.send.reset()

  leader.handleRejectEntries(follower, 1, { conflictingIndex: 2 })
  t.true(follower.send.notCalled)
})

test('handleAcceptEntries() sends remaining entries to the follower if its nextIndex (after potentially updating) is within the log boundary', t => {
  const { leader, peers: [, follower] } = t.context
  // The second peer still has the initial matchIndex of 0, and
  // nextIndex of 3. Converge so nextIndex is 1.
  leader.handleRejectEntries(follower, 1, { conflictingIndex: 1 })
  follower.send.reset()

  // Now pretend to accept the entry at index 1.
  leader.handleAcceptEntries(follower, 1, { lastLogIndex: 1 })
  t.true(follower.send.calledOnce)
  wasEntries(t, follower.send.firstCall, { prevLogIndex: 1, leaderCommit: 0, entryIndexes: [2] })

  // Repeat. The nextIndex will now be 2 so it doesn't need updating.
  // It's still smaller than the last index of the log though, so the
  // last entry will be sent.
  leader.handleAcceptEntries(follower, 1, { lastLogIndex: 1 })
  t.true(follower.send.calledTwice)
  wasEntries(t, follower.send.secondCall, { prevLogIndex: 1, leaderCommit: 0, entryIndexes: [2] })
})

// Note that the leader has three followers. An entry should be replicated to
// two followers before a majority of the cluster contains the entry.
beforeMarkReplication.test('markReplication() commits the entry within the range once it has sufficiently replicated', t => {
  const { appendedValues, leader, log } = t.context
  const [first] = appendedValues

  leader.markReplication(first.index, first.index)
  t.true(log.commit.notCalled)

  leader.markReplication(first.index, first.index)
  t.true(log.commit.calledOnce)
  const { args: [index] } = log.commit.firstCall
  t.true(index === first.index)
})

beforeMarkReplication.test('markReplication() commits subsequent entries within the range, in order, if they have sufficiently replicated', t => {
  const { appendedValues, leader, log } = t.context
  const [first, second] = appendedValues
  leader.markReplication(first.index, second.index)
  t.true(log.commit.notCalled)

  leader.markReplication(first.index, second.index)
  t.true(log.commit.calledTwice)
  const { args: [[firstIndex], [secondIndex]] } = log.commit
  t.true(firstIndex === first.index)
  t.true(secondIndex === second.index)
})

beforeMarkReplication.test('markReplication() does not commit any entries if an entry before the startIndex has not sufficiently replicated', t => {
  const { appendedValues, leader, log } = t.context
  const [, second] = appendedValues
  leader.markReplication(second.index, second.index)
  t.true(log.commit.notCalled)
  leader.markReplication(second.index, second.index)
  t.true(log.commit.notCalled)
})

beforeMarkReplication.test('markReplication() updates the commit index to be the index of the entry being commited', t => {
  const { appendedValues, leader, peers: [follower] } = t.context
  const [first] = appendedValues
  leader.markReplication(first.index, first.index)
  leader.markReplication(first.index, first.index)

  // Send a heartbeat message. It'll include the commit index of the leader.
  follower.send.reset()
  leader.sendHeartbeat() // First heartbeat is skipped
  leader.sendHeartbeat()
  wasHeartbeat(t, follower.send.firstCall, { prevLogIndex: first.index - 1, leaderCommit: first.index })
})

test('append() returns a promise', t => {
  const { leader } = t.context
  t.true(leader.append() instanceof Promise)
})

test(usesScheduler, 'append')

test('append() rejects the returned promise if the scheduler is aborted', async t => {
  const { leader } = t.context
  // Mimick abort by calling the abortHandler
  stub(leader.scheduler, 'asap').callsArg(0)
  t.throws(leader.append(), Error, 'Aborted')
})

test('append() appends the value to the log', t => {
  const { leader, log } = t.context
  log.appendValue.returns(new Promise(() => {}))
  const value = Symbol()
  leader.append(value)
  t.true(log.appendValue.calledOnce)
  const { args: [term, appended] } = log.appendValue.firstCall
  t.true(term === 2)
  t.true(appended === value)
})

test('append() rejects the returned promise if the leader is destroyed while appending the value', async t => {
  const { leader, log } = t.context
  let appended
  log.appendValue.returns(new Promise(resolve => {
    appended = resolve
  }))

  const promise = leader.append()
  leader.destroy()
  appended()

  t.throws(promise, Error, 'No longer leader')
})

afterAppend.test('append() sends new entries to each peer', t => {
  const { peers } = t.context
  for (const peer of peers) {
    t.true(peer.send.calledOnce)
    // Entry's at index 1 and 2 still needed to be sent. Entry 3 is the
    // new one.
    wasEntries(t, peer.send.firstCall, { prevLogIndex: 0, leaderCommit: 0, entryIndexes: [1, 2, 3] })
  }
})

afterAppend.test('append() prevents the next heartbeat message from being sent', t => {
  const { clock, heartbeatInterval, leader, peers } = t.context
  for (const peer of peers) {
    peer.send.reset()
  }

  leader.start()
  clock.tick(heartbeatInterval)
  for (const peer of peers) {
    t.true(peer.send.notCalled)
  }
})

afterAppend.test('append() resumes sending the heartbeat message after skipping the immediate one', t => {
  const { clock, heartbeatInterval, leader, peers } = t.context
  for (const peer of peers) {
    peer.send.reset()
  }

  leader.start()
  clock.tick(heartbeatInterval)
  for (const peer of peers) {
    t.true(peer.send.notCalled)
  }

  clock.tick(heartbeatInterval)
  for (const peer of peers) {
    t.true(peer.send.calledOnce)
    wasHeartbeat(t, peer.send.firstCall, { prevLogIndex: 0, leaderCommit: 0 })
  }
})

canAppend.test('append() fulfills the returned promise with the result of committing the entry', async t => {
  const { appendedValues, leader, leaderAppend } = t.context
  const value = Symbol()
  await leaderAppend([value])

  const [first] = appendedValues
  // As per the markReplication() tests, two marks are needed.
  leader.markReplication(first.index, first.index)
  leader.markReplication(first.index, first.index)

  // As per supportAppend(), the promise is fulfilled with the original
  // value when committed.
  t.true(await first.promise === value)
})

canAppend.test('append() rejects the returned promise when the leader is destroyed', async t => {
  const { leader } = t.context
  const promise = leader.append(Symbol())
  await Promise.resolve()
  leader.destroy()
  t.throws(promise, Error, 'No longer leader')
})
