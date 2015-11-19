import { after, afterEach, before, beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import proxyquire from 'proxyquire'
import { install as installClock } from 'lolex'
import sinon from 'sinon'

import { stubLog, stubMessages, stubPeer, stubState } from './support/stub-helpers'

import {
  AppendEntries, RejectEntries,
  RequestVote, DenyVote, GrantVote
} from '../lib/symbols'

import InputConsumer from '../lib/InputConsumer'
import Scheduler from '../lib/Scheduler'

describe('roles/Candidate', () => {
  before(ctx => ctx.clock = installClock(0, ['setTimeout', 'clearTimeout']))
  after(ctx => ctx.clock.uninstall())

  before(ctx => {
    ctx.InputConsumer = sinon.spy(function (...args) { return new InputConsumer(...args) })
    ctx.Scheduler = sinon.spy(function (...args) { return new Scheduler(...args) })

    ctx.Candidate = proxyquire.noCallThru()('../lib/roles/Candidate', {
      '../InputConsumer': function (...args) { return ctx.InputConsumer(...args) },
      '../Scheduler': function (...args) { return ctx.Scheduler(...args) }
    })['default']
  })

  beforeEach(ctx => {
    ctx.InputConsumer.reset()
    ctx.Scheduler.reset()

    const ourId = ctx.ourId = Symbol()
    const electionTimeout = ctx.electionTimeout = 10
    const state = ctx.state = stubState()
    const log = ctx.log = stubLog()
    const peers = ctx.peers = [ctx.peer = stubPeer(), stubPeer(), stubPeer()]
    const nonPeerReceiver = ctx.nonPeerReceiver = sinon.stub({ messages: stubMessages() })
    const crashHandler = ctx.crashHandler = sinon.stub()
    const convertToFollower = ctx.convertToFollower = sinon.stub()
    const becomeLeader = ctx.becomeLeader = sinon.stub()

    ctx.candidate = new ctx.Candidate({ ourId, electionTimeout, state, log, peers, nonPeerReceiver, crashHandler, convertToFollower, becomeLeader })
  })

  afterEach(ctx => !ctx.candidate.destroyed && ctx.candidate.destroy())

  describe('constructor ({ ourId, electionTimeout, state, log, peers, nonPeerReceiver, crashHandler, convertToFollower, becomeLeader })', () => {
    it('instantiates a scheduler', ctx => {
      assert(ctx.candidate.scheduler instanceof Scheduler)
      sinon.assert.calledOnce(ctx.Scheduler)
      const { args: [crashHandler] } = ctx.Scheduler.getCall(0)
      assert(crashHandler === ctx.crashHandler)
    })

    it('instantiates an input consumer', ctx => {
      assert(ctx.candidate.inputConsumer instanceof InputConsumer)
    })

    it('instantiates an input consumer', ctx => {
      assert(ctx.candidate.inputConsumer instanceof InputConsumer)
      sinon.assert.calledOnce(ctx.InputConsumer)
      const { args: [{ peers, nonPeerReceiver, scheduler, handleMessage, crashHandler }] } = ctx.InputConsumer.getCall(0)
      assert(peers === ctx.peers)
      assert(nonPeerReceiver === ctx.nonPeerReceiver)
      assert(scheduler === ctx.candidate.scheduler)
      assert(typeof handleMessage === 'function')
      assert(crashHandler === ctx.crashHandler)
    })

    context('a message is read by the input consumer', () => {
      it(`calls handleMessage on the candidate`, ctx => {
        // Ensure message can be read
        const message = Symbol()
        ctx.peer.messages.take.onCall(0).returns(message)
        ctx.peer.messages.canTake.onCall(0).returns(true)

        let handleMessage = sinon.stub(ctx.candidate, 'handleMessage')
        ctx.candidate.inputConsumer.start()

        sinon.assert.calledOnce(handleMessage)
        sinon.assert.calledOn(handleMessage, ctx.candidate)
        sinon.assert.calledWithExactly(handleMessage, ctx.peer, message)
      })
    })
  })

  describe('#start ()', () => {
    it('requests a vote', ctx => {
      const spy = sinon.spy(ctx.candidate, 'requestVote')
      ctx.candidate.start()
      sinon.assert.calledOnce(spy)
    })

    it('starts the input consumer', ctx => {
      const spy = sinon.spy(ctx.candidate.inputConsumer, 'start')
      ctx.candidate.start()
      sinon.assert.calledOnce(spy)
    })
  })

  describe('#destroy ()', () => {
    it('clears the election timer', async ctx => {
      const spy = sinon.spy(ctx.candidate, 'requestVote') // spy on the method called by the timer

      ctx.candidate.start()
      sinon.assert.calledOnce(spy) // should be called after starting
      await Promise.resolve() // wait for the timer to be started

      ctx.candidate.destroy() // should prevent the timer from triggering
      ctx.clock.tick(ctx.electionTimeout) // timer should fire now, if not cleared
      sinon.assert.calledOnce(spy) // should not be called again
    })

    it('stops the input consumer', ctx => {
      const spy = sinon.spy(ctx.candidate.inputConsumer, 'stop')
      ctx.candidate.destroy()
      sinon.assert.calledOnce(spy)
    })

    it('aborts the scheduler', ctx => {
      const spy = sinon.spy(ctx.candidate.scheduler, 'abort')
      ctx.candidate.destroy()
      sinon.assert.calledOnce(spy)
    })
  })

  describe('#requestVote ()', () => {
    it('is gated by the scheduler', ctx => {
      // Only checks whether the scheduler is used. Not a perfect test since it
      // doesn't confirm that the operation is actually gated by the scheduler.
      const spy = sinon.spy(ctx.candidate.scheduler, 'asap')
      ctx.candidate.requestVote()
      sinon.assert.calledOnce(spy)
    })

    it('advances the term, voting for itself', ctx => {
      ctx.candidate.requestVote()
      sinon.assert.calledOnce(ctx.state.nextTerm)
      sinon.assert.calledWithExactly(ctx.state.nextTerm, ctx.ourId)
    })

    context('the candidate was destroyed while persisting the state', () => {
      it('does not send RequestVote messages', async ctx => {
        let persisted
        ctx.state.nextTerm.returns(new Promise(resolve => persisted = resolve))

        ctx.candidate.requestVote()
        ctx.candidate.destroy()
        persisted()

        await Promise.resolve()
        sinon.assert.notCalled(ctx.peer.send)
      })

      it('does not set the election timer', async ctx => {
        let persisted
        ctx.state.nextTerm.returns(new Promise(resolve => persisted = resolve))

        ctx.candidate.requestVote()
        ctx.candidate.destroy()
        persisted()

        await Promise.resolve()
        const spy = sinon.spy(ctx.candidate, 'requestVote')
        ctx.clock.tick(ctx.electionTimeout)
        sinon.assert.notCalled(spy)
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
          const { args: [message] } = send.getCall(0)
          assert.deepStrictEqual(message, { type: RequestVote, term, lastLogIndex, lastLogTerm })
        }
      })

      context('the election times out', () => {
        it('requests another vote', async ctx => {
          ctx.candidate.requestVote()
          await Promise.resolve()

          const spy = sinon.spy(ctx.candidate, 'requestVote')
          ctx.clock.tick(ctx.electionTimeout)
          sinon.assert.calledOnce(spy)
        })
      })
    })
  })

  describe('#handleMessage (peer, message)', () => {
    context('the message’s term is newer', () => {
      beforeEach(ctx => {
        ctx.state._currentTerm.returns(1)
        ctx.message = { term: 2 }
      })

      it('sets the term to that of the message', ctx => {
        ctx.candidate.handleMessage(ctx.peer, ctx.message)
        sinon.assert.calledOnce(ctx.state.setTerm)
        sinon.assert.calledWithExactly(ctx.state.setTerm, 2)
      })

      it('returns a promise', ctx => {
        assert(ctx.candidate.handleMessage(ctx.peer, ctx.message) instanceof Promise)
      })

      context('the candidate was destroyed while persisting the state', () => {
        it('does not convert to follower', async ctx => {
          let persisted
          ctx.state.setTerm.returns(new Promise(resolve => persisted = resolve))

          ctx.candidate.handleMessage(ctx.peer, ctx.message)
          ctx.candidate.destroy()
          persisted()

          await Promise.resolve()
          sinon.assert.notCalled(ctx.convertToFollower)
        })
      })

      context('the candidate was not destroyed while persisting the state', () => {
        it('converts to follower', async ctx => {
          await ctx.candidate.handleMessage(ctx.peer, ctx.message)
          sinon.assert.calledOnce(ctx.convertToFollower)
          sinon.assert.calledWithMatch(ctx.convertToFollower, [sinon.match.same(ctx.peer), sinon.match.same(ctx.message)])
        })
      })
    })

    ;[
      { type: RequestVote, label: 'RequestVote', method: 'handleRequestVote' },
      { type: GrantVote, label: 'GrantVote', method: 'handleGrantVote' },
      { type: AppendEntries, label: 'AppendEntries', method: 'handleAppendEntries' }
    ].forEach(({ type, label, method }) => {
      context(`the message type is ${label}`, () => {
        it(`calls ${method} with the peer, the message’s term, and the message itself`, ctx => {
          const stub = sinon.stub(ctx.candidate, method)
          const message = { type, term: 1 }
          ctx.candidate.handleMessage(ctx.peer, message)

          sinon.assert.calledOnce(stub)
          sinon.assert.calledWithExactly(stub, ctx.peer, message.term, message)
        })

        it(`returns the result of calling ${method}`, ctx => {
          const result = Symbol()
          sinon.stub(ctx.candidate, method).returns(result)
          assert(ctx.candidate.handleMessage(ctx.peer, { type, term: 1 }) === result)
        })
      })
    })

    context('the message type is unknown', () => {
      it('doesn’t do anything', ctx => {
        assert(ctx.candidate.handleMessage(ctx.peer, { type: Symbol(), term: 1 }) === undefined)
      })
    })
  })

  describe('#handleRequestVote (peer, term)', () => {
    context('the term is older', () => {
      it('sends a DenyVote message to the peer', ctx => {
        ctx.state._currentTerm.returns(2)
        ctx.candidate.handleRequestVote(ctx.peer, 1)

        sinon.assert.calledOnce(ctx.peer.send)
        const { args: [denied] } = ctx.peer.send.getCall(0)
        assert.deepStrictEqual(denied, { type: DenyVote, term: 2 })
      })
    })

    context('the term is the same', () => {
      it('ignores the request', ctx => {
        ctx.state._currentTerm.returns(2)
        ctx.candidate.handleRequestVote(ctx.peer, 2)

        sinon.assert.notCalled(ctx.peer.send)
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
        sinon.assert.notCalled(ctx.becomeLeader)

        // The next proper vote should be counted, a majority reached, and the
        // candidate becomes leader.
        ctx.candidate.handleGrantVote(ctx.peer, 2)
        sinon.assert.calledOnce(ctx.becomeLeader)
      })
    })

    context('a vote was already received from the peer', () => {
      it('does not count the vote', ctx => {
        ctx.candidate.handleGrantVote(ctx.peers[1], 2) // already voted
        sinon.assert.notCalled(ctx.becomeLeader)

        // The next proper vote should be counted, a majority reached, and the
        // candidate becomes leader.
        ctx.candidate.handleGrantVote(ctx.peer, 2)
        sinon.assert.calledOnce(ctx.becomeLeader)
      })
    })

    context('at least half of the peers have voted for the candidate', () => {
      it('becomes leader', ctx => {
        ctx.candidate.handleGrantVote(ctx.peer, 2)
        sinon.assert.calledOnce(ctx.becomeLeader)
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
        sinon.assert.notCalled(ctx.becomeLeader)
        ctx.candidate.handleGrantVote(ctx.peers[2], 2)
        sinon.assert.calledOnce(ctx.becomeLeader)
      })

      describe('a peer that voted in a previous election', () => {
        it('can vote again', ctx => {
          ctx.candidate.handleGrantVote(ctx.peer, 2)
          sinon.assert.notCalled(ctx.becomeLeader)
          // peers[1] voted in the previous election.
          ctx.candidate.handleGrantVote(ctx.peers[1], 2)
          sinon.assert.calledOnce(ctx.becomeLeader)
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

        sinon.assert.calledOnce(ctx.convertToFollower)
        sinon.assert.calledWithMatch(ctx.convertToFollower, [sinon.match.same(ctx.peer), sinon.match.same(message)])
      })
    })

    context('the term is older', () => {
      it('rejects the entries', ctx => {
        ctx.state._currentTerm.returns(2)
        ctx.candidate.handleAppendEntries(ctx.peer, 1, {})

        sinon.assert.calledOnce(ctx.peer.send)
        const { args: [rejected] } = ctx.peer.send.getCall(0)
        assert.deepStrictEqual(rejected, { type: RejectEntries, term: 2 })
      })
    })
  })
})
