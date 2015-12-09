import { resolve } from 'path'

import { after, afterEach, before, beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import { install as installClock } from 'lolex'
import { spy, stub } from 'sinon'

import {
  setupConstructors,
  testFollowerConversion,
  testInputConsumerDestruction, testInputConsumerInstantiation, testInputConsumerStart,
  testMessageHandlerMapping,
  testSchedulerDestruction, testSchedulerInstantiation
} from './support/role-tests'
import { stubLog, stubMessages, stubPeer, stubState } from './support/stub-helpers'

import {
  AppendEntries, RejectEntries,
  RequestVote, DenyVote, GrantVote
} from '../lib/symbols'

describe('roles/Candidate', () => {
  before(ctx => ctx.clock = installClock(0, ['setTimeout', 'clearTimeout']))
  after(ctx => ctx.clock.uninstall())

  setupConstructors(resolve(__dirname, '../lib/roles/Candidate'))

  beforeEach(ctx => {
    const ourId = ctx.ourId = Symbol()
    const electionTimeout = ctx.electionTimeout = 10
    const state = ctx.state = stubState()
    const log = ctx.log = stubLog()
    const peers = ctx.peers = [ctx.peer = stubPeer(), stubPeer(), stubPeer()]
    const nonPeerReceiver = ctx.nonPeerReceiver = stub({ messages: stubMessages() })
    const crashHandler = ctx.crashHandler = stub()
    const convertToFollower = ctx.convertToFollower = stub()
    const becomeLeader = ctx.becomeLeader = stub()

    ctx.candidate = new ctx.Candidate({ ourId, electionTimeout, state, log, peers, nonPeerReceiver, crashHandler, convertToFollower, becomeLeader })
  })

  afterEach(ctx => !ctx.candidate.destroyed && ctx.candidate.destroy())

  describe('constructor ({ ourId, electionTimeout, state, log, peers, nonPeerReceiver, crashHandler, convertToFollower, becomeLeader })', () => {
    testInputConsumerInstantiation('candidate', ctx => ctx.candidate, ctx => ctx.crashHandler)
    testSchedulerInstantiation(ctx => ctx.candidate, ctx => ctx.crashHandler)
  })

  describe('#start ()', () => {
    it('requests a vote', ctx => {
      spy(ctx.candidate, 'requestVote')
      ctx.candidate.start()
      assert(ctx.candidate.requestVote.calledOnce)
    })

    testInputConsumerStart(ctx => ctx.candidate)
  })

  describe('#destroy ()', () => {
    it('clears the election timer', async ctx => {
      spy(ctx.candidate, 'requestVote') // spy on the method called by the timer

      ctx.candidate.start()
      assert(ctx.candidate.requestVote.calledOnce) // should be called after starting
      await Promise.resolve() // wait for the timer to be started

      ctx.candidate.destroy() // should prevent the timer from triggering
      ctx.clock.tick(ctx.electionTimeout) // timer should fire now, if not cleared
      assert(ctx.candidate.requestVote.calledOnce) // should not be called again
    })

    testInputConsumerDestruction(ctx => ctx.candidate)
    testSchedulerDestruction(ctx => ctx.candidate)
  })

  describe('#requestVote ()', () => {
    it('is gated by the scheduler', ctx => {
      // Only checks whether the scheduler is used. Not a perfect test since it
      // doesn't confirm that the operation is actually gated by the scheduler.
      spy(ctx.candidate.scheduler, 'asap')
      ctx.candidate.requestVote()
      assert(ctx.candidate.scheduler.asap.calledOnce)
    })

    it('advances the term, voting for itself', ctx => {
      ctx.candidate.requestVote()
      assert(ctx.state.nextTerm.calledOnce)
      const { args: [id] } = ctx.state.nextTerm.firstCall
      assert(id === ctx.ourId)
    })

    context('the candidate was destroyed while persisting the state', () => {
      it('does not send RequestVote messages', async ctx => {
        let persisted
        ctx.state.nextTerm.returns(new Promise(resolve => persisted = resolve))

        ctx.candidate.requestVote()
        ctx.candidate.destroy()
        persisted()

        await Promise.resolve()
        assert(ctx.peer.send.notCalled)
      })

      it('does not set the election timer', async ctx => {
        let persisted
        ctx.state.nextTerm.returns(new Promise(resolve => persisted = resolve))

        ctx.candidate.requestVote()
        ctx.candidate.destroy()
        persisted()

        await Promise.resolve()
        spy(ctx.candidate, 'requestVote')
        ctx.clock.tick(ctx.electionTimeout)
        assert(ctx.candidate.requestVote.notCalled)
      })
    })

    context('the candidate was not destroyed while persisting the state', () => {
      it('sends a RequestVote message to each peer', async ctx => {
        const term = Symbol()
        ctx.state._currentTerm.returns(term)
        const [lastLogIndex, lastLogTerm] = [Symbol(), Symbol()]
        ctx.log._lastIndex.returns(lastLogIndex)
        ctx.log._lastTerm.returns(lastLogTerm)

        ctx.candidate.requestVote()
        await Promise.resolve()

        for (const { send } of ctx.peers) {
          const { args: [message] } = send.firstCall
          assert.deepStrictEqual(message, { type: RequestVote, term, lastLogIndex, lastLogTerm })
        }
      })

      context('the election times out', () => {
        it('requests another vote', async ctx => {
          ctx.candidate.requestVote()
          await Promise.resolve()

          spy(ctx.candidate, 'requestVote')
          ctx.clock.tick(ctx.electionTimeout)
          assert(ctx.candidate.requestVote.calledOnce)
        })
      })
    })
  })

  describe('#handleMessage (peer, message)', () => {
    testFollowerConversion('candidate', ctx => ctx.candidate)

    testMessageHandlerMapping(ctx => [ctx.candidate, ctx.peer], [
      { type: RequestVote, label: 'RequestVote', method: 'handleRequestVote' },
      { type: GrantVote, label: 'GrantVote', method: 'handleGrantVote' },
      { type: AppendEntries, label: 'AppendEntries', method: 'handleAppendEntries' }
    ])
  })

  describe('#handleRequestVote (peer, term)', () => {
    context('the term is older', () => {
      it('sends a DenyVote message to the peer', ctx => {
        ctx.state._currentTerm.returns(2)
        ctx.candidate.handleRequestVote(ctx.peer, 1)

        assert(ctx.peer.send.calledOnce)
        const { args: [denied] } = ctx.peer.send.firstCall
        assert.deepStrictEqual(denied, { type: DenyVote, term: 2 })
      })
    })

    context('the term is the same', () => {
      it('ignores the request', ctx => {
        ctx.state._currentTerm.returns(2)
        ctx.candidate.handleRequestVote(ctx.peer, 2)

        assert(ctx.peer.send.notCalled)
      })
    })
  })

  describe('#handleGrantVote (peer, term)', () => {
    beforeEach(async ctx => {
      ctx.candidate.requestVote()
      ctx.state._currentTerm.returns(2) // expect a vote for the second term
      await Promise.resolve()

      // There are three peers, so need to receive a vote from two. Seed one
      // vote to make the tests easier.
      ctx.candidate.handleGrantVote(ctx.peers[1], 2)
    })

    context('the term is not the current term', () => {
      it('does not count the vote', ctx => {
        ctx.candidate.handleGrantVote(ctx.peer, 1) // outdated term
        assert(ctx.becomeLeader.notCalled)

        // The next proper vote should be counted, a majority reached, and the
        // candidate becomes leader.
        ctx.candidate.handleGrantVote(ctx.peer, 2)
        assert(ctx.becomeLeader.calledOnce)
      })
    })

    context('a vote was already received from the peer', () => {
      it('does not count the vote', ctx => {
        ctx.candidate.handleGrantVote(ctx.peers[1], 2) // already voted
        assert(ctx.becomeLeader.notCalled)

        // The next proper vote should be counted, a majority reached, and the
        // candidate becomes leader.
        ctx.candidate.handleGrantVote(ctx.peer, 2)
        assert(ctx.becomeLeader.calledOnce)
      })
    })

    context('at least half of the peers have voted for the candidate', () => {
      it('becomes leader', ctx => {
        ctx.candidate.handleGrantVote(ctx.peer, 2)
        assert(ctx.becomeLeader.calledOnce)
      })
    })

    // This test whether state is reset when a new election is started. That's
    // part of requestVote() but without looking into the class only really
    // testable here.
    context('after a vote was received, a new election is started', () => {
      beforeEach(async ctx => {
        // Remember there's a beforeEach in the parent context which started
        // the previous election.
        ctx.candidate.requestVote()
        await Promise.resolve()
      })

      it('again requires votes from at least half the peers', ctx => {
        ctx.candidate.handleGrantVote(ctx.peer, 2)
        assert(ctx.becomeLeader.notCalled)
        ctx.candidate.handleGrantVote(ctx.peers[2], 2)
        assert(ctx.becomeLeader.calledOnce)
      })

      describe('a peer that voted in a previous election', () => {
        it('can vote again', ctx => {
          ctx.candidate.handleGrantVote(ctx.peer, 2)
          assert(ctx.becomeLeader.notCalled)
          // peers[1] voted in the previous election.
          ctx.candidate.handleGrantVote(ctx.peers[1], 2)
          assert(ctx.becomeLeader.calledOnce)
        })
      })
    })
  })

  describe('#handleAppendEntries (peer, term, message)', () => {
    context('the term is the current term', () => {
      it('converts to follower', ctx => {
        ctx.state._currentTerm.returns(1)
        const message = {}
        ctx.candidate.handleAppendEntries(ctx.peer, 1, message)

        assert(ctx.convertToFollower.calledOnce)
        const { args: [replayMessage] } = ctx.convertToFollower.firstCall
        assert(replayMessage[0] === ctx.peer)
        assert(replayMessage[1] === message)
      })
    })

    context('the term is older', () => {
      it('rejects the entries', ctx => {
        ctx.state._currentTerm.returns(2)
        ctx.candidate.handleAppendEntries(ctx.peer, 1, {})

        assert(ctx.peer.send.calledOnce)
        const { args: [rejected] } = ctx.peer.send.firstCall
        assert.deepStrictEqual(rejected, { type: RejectEntries, term: 2 })
      })
    })
  })
})
