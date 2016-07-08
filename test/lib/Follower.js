// https://github.com/avajs/eslint-plugin-ava/issues/127
/* eslint-disable ava/use-t */

import test from 'ava'
import { spy, stub } from 'sinon'

import {
  AppendEntries, RejectEntries, AcceptEntries,
  RequestVote, DenyVote, GrantVote
} from 'dist/lib/symbols'

import Entry from 'dist/lib/Entry'

import dist from './helpers/dist'
import fork from './helpers/fork-context'
import macro from './helpers/macro'
import {
  setupConstructors,
  testInputConsumerDestruction, testInputConsumerInstantiation, testInputConsumerStart,
  testMessageHandlerMapping,
  testSchedulerDestruction, testSchedulerInstantiation
} from './helpers/role-tests'
import { stubLog, stubMessages, stubPeer, stubState, stubTimers } from './helpers/stub-helpers'

// Don't use the Promise introduced by babel-runtime. https://github.com/avajs/ava/issues/947
const { Promise } = global

const Follower = setupConstructors(dist('lib/roles/Follower'))

const usesScheduler = macro((t, method, getArgs = () => []) => {
  const { follower } = t.context
  // Only checks whether the scheduler is used. Not a perfect test since
  // it doesn't confirm that the operation is actually gated by the
  // scheduler.
  spy(follower.scheduler, 'asap')
  follower[method](...getArgs(t.context))
  t.true(follower.scheduler.asap.calledOnce)
}, (condition, method) => `${method}() uses the scheduler ${condition}`.trim())

const ignoresRequest = macro(async (t, term, lastLogIndex, lastLogTerm) => {
  const { candidate, follower } = t.context
  // The other arguments should cause the vote to be granted, were it not
  // for the log index.
  await follower.handleRequestVote(candidate, term, { lastLogIndex, lastLogTerm })
  // Verify no messages were sent.
  t.true(candidate.send.notCalled)
}, condition => `handleRequestVote() ignores the request if the candidate's ${condition}`)

const setsTerm = macro(async (t, term, lastLogIndex, lastLogTerm) => {
  const { candidate, follower, state } = t.context
  await follower.handleRequestVote(candidate, term, { lastLogIndex, lastLogTerm })
  t.true(state.setTerm.calledOnce)
  const { args: [value] } = state.setTerm.firstCall
  t.true(value === term)
}, condition => `handleRequestVote() updates its term to that of the candidate if it is ahead, even if the candidate’s ${condition}`)

const returnsPromiseForTermUpdate = macro(async (t, term, lastLogIndex, lastLogTerm) => {
  const { candidate, follower, state } = t.context
  let updated
  state.setTerm.returns(new Promise(resolve => {
    updated = resolve
  }))

  const promise = follower.handleRequestVote(candidate, term, { lastLogIndex, lastLogTerm })

  const probe = Symbol()
  updated(probe)

  t.true(await promise === probe)
}, condition => `handleRequestVote() returns a promise for when its term is updated, even if candidate’s ${condition}`)

const setsTermAndVotes = macro(async (t, term, lastLogIndex, lastLogTerm) => {
  const { candidate, follower, state } = t.context
  await follower.handleRequestVote(candidate, term, { lastLogIndex, lastLogTerm })

  t.true(state.setTermAndVote.calledOnce)
  const { args: [value, id] } = state.setTermAndVote.firstCall
  t.true(value === term)
  t.true(id === candidate.id)
}, condition => `handleRequestVote() sets its term to that of the candidate, and votes, if the candidate's ${condition}`)

const dontBecomeCandidateAfterFirstTimeout = macro(t => {
  const { clock, electionTimeout, follower } = t.context
  clock.tick(electionTimeout)
  t.true(follower.convertToCandidate.notCalled)
}, prefix => `${prefix}, if no other messages are received before the election timeout, the follower does not yet become a candidate`)

const becomeCandidateAfterSecondTimeout = macro(t => {
  const { clock, electionTimeout, follower } = t.context
  clock.tick(electionTimeout)
  t.true(follower.convertToCandidate.notCalled)

  clock.tick(electionTimeout)
  t.true(follower.convertToCandidate.calledOnce)
}, prefix => `${prefix}, if no other messages are received before the election timeout, the follower does not yet become a candidate`)

test.beforeEach(t => {
  const convertToCandidate = stub()
  const crashHandler = stub()
  const electionTimeout = 10
  const log = stubLog()
  const nonPeerReceiver = stub({ messages: stubMessages() })
  const peers = [stubPeer(), stubPeer(), stubPeer()]
  const state = stubState()
  const { clock, timers } = stubTimers()

  state._currentTerm.returns(2)

  const follower = new Follower({
    convertToCandidate,
    crashHandler,
    electionTimeout,
    log,
    nonPeerReceiver,
    peers,
    state,
    timers
  })

  Object.assign(t.context, {
    convertToCandidate,
    clock,
    crashHandler,
    electionTimeout,
    follower,
    log,
    nonPeerReceiver,
    peers,
    state
  })
})

test.afterEach(t => {
  const { follower } = t.context
  if (!follower.destroyed) follower.destroy()
})

const beforeVoteRequest = fork().beforeEach(t => {
  const { log, peers: [candidate] } = t.context
  log._lastIndex.returns(2)
  log._lastTerm.returns(2)
  Object.assign(t.context, { candidate })
})

const hasVotedForCandidate = beforeVoteRequest.fork().beforeEach(t => {
  const { candidate, state } = t.context
  state._votedFor.returns(candidate.id)
})

const hasVotedForOtherCandidate = beforeVoteRequest.fork().beforeEach(t => {
  const { peers: [, otherCandidate], state } = t.context
  state._votedFor.returns(otherCandidate)
})

const sentGrantVote = beforeVoteRequest.fork().beforeEach(async t => {
  const { candidate, follower } = t.context
  follower.start()
  await follower.handleRequestVote(candidate, 3, { lastLogIndex: 2, lastLogTerm: 2 })
})

const appendingEntries = fork().beforeEach(async t => {
  const { follower, peers: [leader] } = t.context
  follower.start()
  await follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
})

testInputConsumerInstantiation('follower')
testSchedulerInstantiation('follower')

test('start() starts the election timer', t => {
  const { clock, electionTimeout, follower } = t.context
  spy(follower, 'maybeStartElection')
  follower.start()

  clock.tick(electionTimeout)
  t.true(follower.maybeStartElection.calledOnce)

  clock.tick(electionTimeout)
  t.true(follower.maybeStartElection.calledTwice)
})

test('start() handles the replay message, if any', t => {
  const { follower, peers: [peer] } = t.context
  spy(follower, 'handleMessage')
  const message = Symbol()
  follower.start([peer, message])

  t.true(follower.handleMessage.calledOnce)
  const { args } = follower.handleMessage.firstCall
  t.true(args[0] === peer)
  t.true(args[1] === message)
})

test('when replaying a message', usesScheduler, 'start', ({ peers: [peer] }) => [peer, Symbol()])

test('start() replays the message before starting the input consumer', t => {
  const { follower, peers: [peer] } = t.context
  const handleMessage = spy(follower, 'handleMessage')
  const start = spy(follower.inputConsumer, 'start')
  follower.start([peer, Symbol()])

  t.true(handleMessage.calledBefore(start))
})

testInputConsumerStart('follower')

test('destroy() clears the election timer', t => {
  const { clock, electionTimeout, follower } = t.context
  spy(follower, 'maybeStartElection') // spy on the method called by the timer

  follower.start()
  follower.destroy() // should prevent the timer from triggering
  clock.tick(electionTimeout) // timer should fire now, if not cleared
  t.true(follower.maybeStartElection.notCalled) // should not be called again
})

testInputConsumerDestruction('follower')
testSchedulerDestruction('follower')

test(usesScheduler, 'maybeStartElection')

test('maybeStartElection() does not schedule again if already scheduled', t => {
  const { follower } = t.context
  const asap = stub(follower.scheduler, 'asap')
  follower.maybeStartElection()
  t.true(asap.calledOnce)

  follower.maybeStartElection()
  t.true(asap.calledOnce)
})

test('maybeStartElection() does schedule again once run', t => {
  const { follower } = t.context
  const asap = stub(follower.scheduler, 'asap')
  follower.maybeStartElection()
  asap.firstCall.yield()

  follower.maybeStartElection()
  t.true(asap.calledTwice)
})

testMessageHandlerMapping('follower', [
  { type: RequestVote, label: 'RequestVote', method: 'handleRequestVote' },
  { type: AppendEntries, label: 'AppendEntries', method: 'handleAppendEntries' }
])

beforeVoteRequest.test('handleRequestVote() sends a DenyVote message to the candidate if its term is older than the current one', async t => {
  const { candidate, follower } = t.context
  await follower.handleRequestVote(candidate, 1, { lastLogIndex: 3, lastLogTerm: 3 })

  t.true(candidate.send.calledOnce)
  const { args: [denied] } = candidate.send.firstCall
  t.deepEqual(denied, { type: DenyVote, term: 2 })
})

for (const [votingCondition, context, shouldGrantVote] of [
  ['not yet voted', beforeVoteRequest, true],
  ['already voted for the candidate', hasVotedForCandidate, true],
  ['already voted for another candidate', hasVotedForOtherCandidate, false]
]) {
  for (const [condition, term, lastLogIndex, lastLogTerm] of [
    [`log index is behind and the follower has ${votingCondition}`, 3, 1, 1],
    [`log term is behind and the follower has ${votingCondition}`, 3, 2, 1]
  ]) {
    context.test(condition, ignoresRequest, term, lastLogIndex, lastLogTerm)
    context.test(condition, setsTerm, term, lastLogIndex, lastLogTerm)
    context.test(condition, returnsPromiseForTermUpdate, term, lastLogIndex, lastLogTerm)
  }

  for (const [condition, lastLogIndex, lastLogTerm] of [
    [`log index is equal, as is its log term, and the follower has ${votingCondition}`, 2, 2],
    [`log index is equal, its log term is ahead, and the follower has ${votingCondition}`, 2, 2],
    [`log index is ahead, its log term is equal, and the follower has ${votingCondition}`, 3, 2],
    [`log index is ahead, its log term is ahead, and the follower has ${votingCondition}`, 3, 3]
  ]) {
    if (shouldGrantVote) {
      context.test(condition, setsTermAndVotes, 3, lastLogIndex, lastLogTerm)
    } else {
      context.test(condition, ignoresRequest, 3, lastLogIndex, lastLogTerm)
    }
  }
}

hasVotedForOtherCandidate.test('handleRequestVote() does not update its term if the candidate’s term is even and the candidate is denied a vote', t => {
  const { candidate, follower, state } = t.context
  follower.handleRequestVote(candidate, 2, { lastLogIndex: 2, lastLogTerm: 2 })
  t.true(state.setTermAndVote.notCalled)
  t.true(state.setTerm.notCalled)
})

beforeVoteRequest.test('handleRequestVote() does not end up sending a GrantVote message to the candidate if the follower is destroyed while persisting its voting state', async t => {
  const { candidate, follower, state } = t.context
  let persisted
  state.setTermAndVote.returns(new Promise(resolve => {
    persisted = resolve
  }))

  follower.handleRequestVote(candidate, 3, { lastLogIndex: 2, lastLogTerm: 2 })
  follower.destroy()
  persisted()

  await Promise.resolve()
  t.true(candidate.send.notCalled)
})

beforeVoteRequest.test('handleRequestVote() sends a GrantVote message to the candidate after the follower has persisting its voting state', async t => {
  const { candidate, follower, state } = t.context
  let persisted
  state.setTermAndVote.returns(new Promise(resolve => {
    persisted = resolve
  }))

  follower.handleRequestVote(candidate, 3, { lastLogIndex: 2, lastLogTerm: 2 })
  t.true(candidate.send.notCalled)
  persisted()

  await Promise.resolve()
  t.true(candidate.send.calledOnce)
  const { args: [granted] } = candidate.send.firstCall
  t.deepEqual(granted, { type: GrantVote, term: 2 })
})

sentGrantVote.test('after granting a vote', dontBecomeCandidateAfterFirstTimeout)
sentGrantVote.test('after granting a vote', becomeCandidateAfterSecondTimeout)

test('handleAppendEntries() sends a RejectEntries message to the leader if its term is behind', t => {
  const { follower, peers: [leader] } = t.context
  follower.handleAppendEntries(leader, 1, { term: 1 })

  t.true(leader.send.calledOnce)
  const { args: [rejected] } = leader.send.firstCall
  t.deepEqual(rejected, { type: RejectEntries, term: 2 })
})

test('handleAppendEntries() does not merge entries if the leader’s term is behind', async t => {
  const { follower, peers: [leader] } = t.context
  // The other arguments should cause the entries to be merged, were it
  // not for the outdated term.
  await follower.handleAppendEntries(leader, 1, { term: 1, prevLogIndex: 0, prevLogTerm: 0, entries: [] })
  // Verify the entries were indeed rejected and no other messages were sent.
  t.true(leader.send.calledOnce)
  const { args: [{ type }] } = leader.send.firstCall
  t.true(type === RejectEntries)
})

test('handleAppendEntries() sends a RejectEntries message to the peer, without merging entries, if it doesn’t have the entry that preceeds the first sent entry (which isn’t the leader’s first entry)', async t => {
  const { follower, log, peers: [leader] } = t.context
  log.getEntry.returns(undefined)
  await follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 1, prevLogTerm: 1, entries: [] })

  t.true(leader.send.calledOnce)
  const { args: [rejected] } = leader.send.firstCall
  t.deepEqual(rejected, { type: RejectEntries, term: 2, conflictingIndex: 1 })
})

test('handleAppendEntries() sends a RejectEntries message to the peer, without merging entries, if its entry that preceeds the first sent entry has the wrong term', async t => {
  const { follower, log, peers: [leader] } = t.context
  log.getEntry.returns(new Entry(1, 2, Symbol()))
  await follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 1, prevLogTerm: 1, entries: [] })

  t.true(leader.send.calledOnce)
  const { args: [rejected] } = leader.send.firstCall
  t.deepEqual(rejected, { type: RejectEntries, term: 2, conflictingIndex: 1 })
})

test('handleAppendEntries() merges the entries if its entry that preceeds the first sent entry has the right term', t => {
  const { follower, log, peers: [leader] } = t.context
  log.getEntry.returns(new Entry(2, 1, Symbol()))
  const entries = Symbol()
  follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 2, prevLogTerm: 1, entries, leaderCommit: 0 })

  t.true(log.mergeEntries.calledOnce)
  const { args: [merged, prevLogIndex, prevLogTerm] } = log.mergeEntries.firstCall
  t.true(merged === entries)
  t.true(prevLogIndex === 2)
  t.true(prevLogTerm === 1)
})

test('handleAppendEntries() merges the entries if the leader sends its first entry', t => {
  const { follower, log, peers: [leader] } = t.context
  const entries = Symbol()
  follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries, leaderCommit: 0 })

  t.true(log.mergeEntries.calledOnce)
  const { args: [merged] } = log.mergeEntries.firstCall
  t.true(merged === entries)
})

appendingEntries.test('when entries are being merged', dontBecomeCandidateAfterFirstTimeout)
appendingEntries.test('when entries are being merged', becomeCandidateAfterSecondTimeout)

test('handleAppendEntries() updates its term to that of the leader if it is ahead, and entries are being merged', t => {
  const { follower, leader, state } = t.context
  follower.handleAppendEntries(leader, 3, { term: 3, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })

  t.true(state.setTerm.calledOnce)
  const { args: [term] } = state.setTerm.firstCall
  t.true(term === 3)
})

test('handleAppendEntries() does not update its term to that of the leader if it is even, and entries are being merged', t => {
  const { follower, leader, state } = t.context
  follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
  t.false(state.setTerm.calledOnce)
})

test('handleAppendEntries() does not send an AcceptEntries message to the candidate, if the follower is destroyed while persisting its term', async t => {
  const { follower, peers: [leader], state } = t.context
  let persisted
  state.setTerm.returns(new Promise(resolve => {
    persisted = resolve
  }))

  follower.handleAppendEntries(leader, 3, { term: 3, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
  t.true(state.setTerm.calledOnce)
  follower.destroy()
  persisted()

  await new Promise(resolve => setImmediate(resolve))
  t.true(leader.send.notCalled)
})

test('handleAppendEntries() sends an AcceptEntries message to the candidate, after the follower has persisted its term', async t => {
  const { follower, peers: [leader], state } = t.context
  let persisted
  state.setTerm.returns(new Promise(resolve => {
    persisted = resolve
  }))

  follower.handleAppendEntries(leader, 3, { term: 3, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
  t.true(state.setTerm.calledOnce)
  state._currentTerm.returns(3)
  persisted()

  await new Promise(resolve => setImmediate(resolve))
  t.true(leader.send.calledOnce)
  const { args: [accepted] } = leader.send.firstCall
  t.deepEqual(accepted, { type: AcceptEntries, term: 3, lastLogIndex: 0 })
})

test('handleAppendEntries() does not send an AcceptEntries message to the candidate, if the follower is destroyed while persisting the entries', async t => {
  const { follower, log, peers: [leader] } = t.context
  let persisted
  log.mergeEntries.returns(new Promise(resolve => {
    persisted = resolve
  }))

  follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
  t.true(log.mergeEntries.calledOnce)
  follower.destroy()
  persisted()

  await new Promise(resolve => setImmediate(resolve))
  t.true(leader.send.notCalled)
})

test('handleAppendEntries() sends an AcceptEntries message to the candidate, after the follower has persisted the entries', async t => {
  const { follower, log, peers: [leader] } = t.context
  let persisted
  log.mergeEntries.returns(new Promise(resolve => {
    persisted = resolve
  }))

  follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
  t.true(log.mergeEntries.calledOnce)
  persisted()

  await new Promise(resolve => setImmediate(resolve))
  t.true(leader.send.calledOnce)
  const { args: [accepted] } = leader.send.firstCall
  t.deepEqual(accepted, { type: AcceptEntries, term: 2, lastLogIndex: 0 })
})

test('handleAppendEntries() commits the log up to the leader’s commit index, if it is ahead', t => {
  const { follower, log, peers: [leader] } = t.context
  follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 1 })
  t.true(log.commit.calledOnce)
  const { args: [commit] } = log.commit.firstCall
  t.true(commit === 1)
})

test('handleAppendEntries() stores the leader’s commit index, if it is ahead', async t => {
  const { follower, log, peers: [leader] } = t.context
  await follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 1 })
  t.true(log.commit.calledOnce)

  // No second commit if the index is the same
  await follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 1 })
  t.true(log.commit.calledOnce)

  // Another commit if the index is higher again
  await follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 2 })
  t.true(log.commit.calledTwice)
})

test('handleAppendEntries() does not commit the log if the leader’s commit index is behind', async t => {
  const { follower, log, peers: [leader] } = t.context
  await follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 10 })
  log.commit.reset()

  await follower.handleAppendEntries(leader, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 5 })
  t.true(log.commit.notCalled)
})
