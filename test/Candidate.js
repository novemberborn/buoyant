import { resolve } from 'path'

import test from 'ava'
import { spy, stub } from 'sinon'

import {
  AppendEntries, RejectEntries,
  RequestVote, DenyVote, GrantVote
} from '../lib/symbols'

import fork from './helpers/fork-context'
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

const Candidate = setupConstructors(resolve(__dirname, '../lib/roles/Candidate'))

test.beforeEach(t => {
  const becomeLeader = stub()
  const convertToFollower = stub()
  const crashHandler = stub()
  const electionTimeout = 10
  const log = stubLog()
  const nonPeerReceiver = stub({ messages: stubMessages() })
  const ourId = Symbol()
  const peers = [stubPeer(), stubPeer(), stubPeer()]
  const state = stubState()
  const { clock, timers } = stubTimers()

  state._currentTerm.returns(1)

  const candidate = new Candidate({
    becomeLeader,
    convertToFollower,
    crashHandler,
    electionTimeout,
    log,
    nonPeerReceiver,
    ourId,
    peers,
    state,
    timers
  })

  Object.assign(t.context, {
    becomeLeader,
    candidate,
    clock,
    convertToFollower,
    crashHandler,
    electionTimeout,
    log,
    nonPeerReceiver,
    ourId,
    peers,
    state
  })
})

test.afterEach(t => {
  const { candidate } = t.context
  if (!candidate.destroyed) candidate.destroy()
})

const afterVoteRequest = fork().beforeEach(async t => {
  const { candidate, peers, state } = t.context
  candidate.requestVote()
  state._currentTerm.returns(2) // expect a vote for the second term
  await Promise.resolve()

  // There are three peers, so need to receive a vote from two. Seed one
  // vote to make the tests easier.
  candidate.handleGrantVote(peers[1], 2)
})

const afterSecondVoteRequest = afterVoteRequest.fork().beforeEach(async t => {
  const { candidate } = t.context
  candidate.requestVote()
  await Promise.resolve()
})

testInputConsumerInstantiation('candidate')
testSchedulerInstantiation('candidate')

test('start() requests a vote', t => {
  const { candidate } = t.context
  spy(candidate, 'requestVote')
  candidate.start()
  t.true(candidate.requestVote.calledOnce)
})

testInputConsumerStart('candidate')

test('destroy() clears the election timer', async t => {
  const { candidate, clock, electionTimeout } = t.context
  spy(candidate, 'requestVote') // spy on the method called by the timer

  candidate.start()
  t.true(candidate.requestVote.calledOnce) // should be called after starting
  await Promise.resolve() // wait for the timer to be started

  candidate.destroy() // should prevent the timer from triggering
  clock.tick(electionTimeout) // timer should fire now, if not cleared
  t.true(candidate.requestVote.calledOnce) // should not be called again
})

testInputConsumerDestruction('candidate')
testSchedulerDestruction('candidate')

test('requestVote() is gated by the scheduler', t => {
  const { candidate } = t.context
  // Only checks whether the scheduler is used. Not a perfect test since it
  // doesn't confirm that the operation is actually gated by the scheduler.
  spy(candidate.scheduler, 'asap')
  candidate.requestVote()
  t.true(candidate.scheduler.asap.calledOnce)
})

test('requestVote() advances the term, voting for itself', t => {
  const { candidate, ourId, state } = t.context
  candidate.requestVote()
  t.true(state.nextTerm.calledOnce)
  const { args: [id] } = state.nextTerm.firstCall
  t.true(id === ourId)
})

test('requestVote() does not send RequestVote messages if the candidate was destroyed while persisting the state', async t => {
  const { candidate, state, peers: [peer] } = t.context
  let persisted
  state.nextTerm.returns(new Promise(resolve => {
    persisted = resolve
  }))

  candidate.requestVote()
  candidate.destroy()
  persisted()

  await Promise.resolve()
  t.true(peer.send.notCalled)
})

test('requestVote() does not set the election timer if the candidate was destroyed while persisting the state', async t => {
  const { candidate, clock, electionTimeout, state } = t.context
  let persisted
  state.nextTerm.returns(new Promise(resolve => {
    persisted = resolve
  }))

  candidate.requestVote()
  candidate.destroy()
  persisted()

  await Promise.resolve()
  spy(candidate, 'requestVote')
  clock.tick(electionTimeout)
  t.true(candidate.requestVote.notCalled)
})

test('requestVote() sends a RequestVote message to each peer', async t => {
  const { candidate, log, peers, state } = t.context
  const term = Symbol()
  state._currentTerm.returns(term)
  const [lastLogIndex, lastLogTerm] = [Symbol(), Symbol()]
  log._lastIndex.returns(lastLogIndex)
  log._lastTerm.returns(lastLogTerm)

  candidate.requestVote()
  await Promise.resolve()

  for (const { send } of peers) {
    const { args: [message] } = send.firstCall
    t.deepEqual(message, { type: RequestVote, term, lastLogIndex, lastLogTerm })
  }
})

test('requestVote() requests another vote if the election times out', async t => {
  const { candidate, clock, electionTimeout } = t.context
  candidate.requestVote()
  await Promise.resolve()

  spy(candidate, 'requestVote')
  clock.tick(electionTimeout)
  t.true(candidate.requestVote.calledOnce)
})

testFollowerConversion('candidate')

testMessageHandlerMapping('candidate', [
  { type: RequestVote, label: 'RequestVote', method: 'handleRequestVote' },
  { type: GrantVote, label: 'GrantVote', method: 'handleGrantVote' },
  { type: AppendEntries, label: 'AppendEntries', method: 'handleAppendEntries' }
])

test('handleRequestVote() sends a DenyVote message to the peer if it sent an older term', t => {
  const { candidate, peers: [peer], state } = t.context
  state._currentTerm.returns(2)
  candidate.handleRequestVote(peer, 1)

  t.true(peer.send.calledOnce)
  const { args: [denied] } = peer.send.firstCall
  t.deepEqual(denied, { type: DenyVote, term: 2 })
})

test('handleRequestVote() ignores the request if the peer’s term is the same as the current term', t => {
  const { candidate, peers: [peer], state } = t.context
  state._currentTerm.returns(2)
  candidate.handleRequestVote(peer, 2)

  t.true(peer.send.notCalled)
})

afterVoteRequest.test('handleGrantVote() disregards votes whose term is not the current one', t => {
  const { becomeLeader, candidate, peers } = t.context
  candidate.handleGrantVote(peers[0], 1) // outdated term
  t.true(becomeLeader.notCalled)

  // The next proper vote should be counted, a majority reached, and the
  // candidate becomes leader.
  candidate.handleGrantVote(peers[0], 2)
  t.true(becomeLeader.calledOnce)
})

afterVoteRequest.test('handleGrantVote() disregards repeated votes in the same election', t => {
  const { becomeLeader, candidate, peers } = t.context
  candidate.handleGrantVote(peers[1], 2) // already voted
  t.true(becomeLeader.notCalled)

  // The next proper vote should be counted, a majority reached, and the
  // candidate becomes leader.
  candidate.handleGrantVote(peers[0], 2)
  t.true(becomeLeader.calledOnce)
})

afterVoteRequest.test('handleGrantVote() causes the candidate to become leader after receiving votes from at least half of the peers', t => {
  const { becomeLeader, candidate, peers } = t.context
  candidate.handleGrantVote(peers[0], 2)
  t.true(becomeLeader.calledOnce)
})

afterSecondVoteRequest.test('handleGrantVote() requires votes from at least half the peers in every election', t => {
  const { becomeLeader, candidate, peers } = t.context
  candidate.handleGrantVote(peers[0], 2)
  t.true(becomeLeader.notCalled)
  candidate.handleGrantVote(peers[2], 2)
  t.true(becomeLeader.calledOnce)
})

afterSecondVoteRequest.test('handleGrantVote() accepts votes from peers that voted in previous elections', t => {
  const { becomeLeader, candidate, peers } = t.context
  candidate.handleGrantVote(peers[0], 2)
  t.true(becomeLeader.notCalled)
  // peers[1] voted in the previous election.
  candidate.handleGrantVote(peers[1], 2)
  t.true(becomeLeader.calledOnce)
})

test('handleAppendEntries() causes the candidate to convert to follower if the term is the same as the current term', t => {
  const { candidate, convertToFollower, peers: [peer], state } = t.context
  state._currentTerm.returns(1)
  const message = {}
  candidate.handleAppendEntries(peer, 1, message)

  t.true(convertToFollower.calledOnce)
  const { args: [replayMessage] } = convertToFollower.firstCall
  t.true(replayMessage[0] === peer)
  t.true(replayMessage[1] === message)
})

test('handleAppendEntries() rejects the entries if the term is older than the current one', t => {
  const { candidate, peers: [peer], state } = t.context
  state._currentTerm.returns(2)
  candidate.handleAppendEntries(peer, 1, {})

  t.true(peer.send.calledOnce)
  const { args: [rejected] } = peer.send.firstCall
  t.deepEqual(rejected, { type: RejectEntries, term: 2 })
})
