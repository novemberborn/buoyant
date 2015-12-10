import { resolve } from 'path'

import { after, afterEach, before, beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import { install as installClock } from 'lolex'
import { spy, stub } from 'sinon'

import {
  setupConstructors,
  testInputConsumerDestruction, testInputConsumerInstantiation, testInputConsumerStart,
  testMessageHandlerMapping,
  testSchedulerDestruction, testSchedulerInstantiation
} from './support/role-tests'
import { stubLog, stubMessages, stubPeer, stubState } from './support/stub-helpers'

import {
  AppendEntries, RejectEntries, AcceptEntries,
  RequestVote, DenyVote, GrantVote
} from '../lib/symbols'

import Entry from '../lib/Entry'

describe('roles/Follower', () => {
  before(ctx => ctx.clock = installClock(0, ['setInterval', 'clearInterval']))
  after(ctx => ctx.clock.uninstall())

  setupConstructors(resolve(__dirname, '../lib/roles/Follower'))

  beforeEach(ctx => {
    const convertToCandidate = ctx.convertToCandidate = stub()
    const crashHandler = ctx.crashHandler = stub()
    const electionTimeout = ctx.electionTimeout = 10
    const log = ctx.log = stubLog()
    const nonPeerReceiver = ctx.nonPeerReceiver = stub({ messages: stubMessages() })
    const peers = ctx.peers = [ctx.peer = stubPeer(), stubPeer(), stubPeer()]
    const state = ctx.state = stubState()

    ctx.follower = new ctx.Follower({ convertToCandidate, crashHandler, electionTimeout, log, nonPeerReceiver, peers, state })
  })

  afterEach(ctx => !ctx.follower.destroyed && ctx.follower.destroy())

  describe('constructor ({ electionTimeout, state, log, peers, nonPeerReceiver, crashHandler, convertToCandidate })', () => {
    testInputConsumerInstantiation('follower', ctx => ctx.follower, ctx => ctx.crashHandler)
    testSchedulerInstantiation(ctx => ctx.follower, ctx => ctx.crashHandler)
  })

  describe('#start (replayMessage)', () => {
    it('starts the election timer', ctx => {
      spy(ctx.follower, 'maybeStartElection')
      ctx.follower.start()

      ctx.clock.tick(ctx.electionTimeout)
      assert(ctx.follower.maybeStartElection.calledOnce)

      ctx.clock.tick(ctx.electionTimeout)
      assert(ctx.follower.maybeStartElection.calledTwice)
    })

    context('there’s a message to be replayed', () => {
      beforeEach(ctx => ctx.message = Symbol())

      it('handles the message', ctx => {
        spy(ctx.follower, 'handleMessage')
        ctx.follower.start([ctx.peer, ctx.message])

        assert(ctx.follower.handleMessage.calledOnce)
        const { args } = ctx.follower.handleMessage.firstCall
        assert(args[0] === ctx.peer)
        assert(args[1] === ctx.message)
      })

      it('uses the scheduler', ctx => {
        // Only checks whether the scheduler is used. Not a perfect test since
        // it doesn't confirm that the operation is actually gated by the
        // scheduler.
        spy(ctx.follower.scheduler, 'asap')
        ctx.follower.start([ctx.peer, ctx.message])
        assert(ctx.follower.scheduler.asap.calledOnce)
      })

      it('replays the message before starting the input consumer', ctx => {
        const handleMessage = spy(ctx.follower, 'handleMessage')
        const start = spy(ctx.follower.inputConsumer, 'start')
        ctx.follower.start([ctx.peer, ctx.message])

        assert(handleMessage.calledBefore(start))
      })
    })

    testInputConsumerStart(ctx => ctx.follower)
  })

  describe('#destroy ()', () => {
    it('clears the election timer', ctx => {
      spy(ctx.follower, 'maybeStartElection') // spy on the method called by the timer

      ctx.follower.start()
      ctx.follower.destroy() // should prevent the timer from triggering
      ctx.clock.tick(ctx.electionTimeout) // timer should fire now, if not cleared
      assert(ctx.follower.maybeStartElection) // should not be called agai.notCalledn
    })

    testInputConsumerDestruction(ctx => ctx.follower)
    testSchedulerDestruction(ctx => ctx.follower)
  })

  // The implementation has an option to ignore election timeouts. This is
  // tested in the handleRequestVote() and handleAppendEntries() tests, since
  // these set the controlling flag.
  describe('#maybeStartElection ()', () => {
    it('uses the scheduler', ctx => {
      // Only checks whether the scheduler is used. Not a perfect test since
      // it doesn't confirm that the operation is actually gated by the
      // scheduler.
      spy(ctx.follower.scheduler, 'asap')
      ctx.follower.maybeStartElection()
      assert(ctx.follower.scheduler.asap.calledOnce)
    })

    context('previously invoked but not yet run', () => {
      it('does not schedule again', ctx => {
        const asap = stub(ctx.follower.scheduler, 'asap')
        ctx.follower.maybeStartElection()
        assert(asap.calledOnce)

        ctx.follower.maybeStartElection()
        assert(asap.calledOnce)
      })
    })

    context('previously invoked and run', () => {
      it('schedules again', ctx => {
        const asap = stub(ctx.follower.scheduler, 'asap')
        ctx.follower.maybeStartElection()
        asap.firstCall.yield()

        ctx.follower.maybeStartElection()
        assert(asap.calledTwice)
      })
    })
  })

  describe('#handleMessage (peer, message)', () => {
    testMessageHandlerMapping(ctx => [ctx.follower, ctx.peer], [
      { type: RequestVote, label: 'RequestVote', method: 'handleRequestVote' },
      { type: AppendEntries, label: 'AppendEntries', method: 'handleAppendEntries' }
    ])
  })

  describe('#handleRequestVote (peer, term, { lastLogIndex, lastLogTerm })', () => {
    beforeEach(ctx => {
      ctx.state._currentTerm.returns(2)
      ctx.log._lastIndex.returns(2)
      ctx.log._lastTerm.returns(2)
    })

    context('the term is older', () => {
      it('sends a DenyVote message to the candidate', ctx => {
        ctx.follower.handleRequestVote(ctx.peer, 1, { term: 1 })

        assert(ctx.peer.send.calledOnce)
        const { args: [denied] } = ctx.peer.send.firstCall
        assert.deepStrictEqual(denied, { type: DenyVote, term: 2 })
      })

      it('does not vote for the candidate', async ctx => {
        ctx.state._votedFor.returns(null)

        // The other arguments should cause the vote to be granted, were it not
        // for the outdated term.
        await ctx.follower.handleRequestVote(ctx.peer, 1, { term: 1, lastLogIndex: 3, lastLogTerm: 3 })
        // Verify the vote was indeed denied and no other messages were sent.
        assert(ctx.peer.send.calledOnce)
        const { args: [{ type }] } = ctx.peer.send.firstCall
        assert(type === DenyVote)
      })
    })

    const doesNotGrantVote = ({ term, lastLogIndex, lastLogTerm }) => {
      it('does not grant its vote to the candidate', async ctx => {
        await ctx.follower.handleRequestVote(ctx.peer, term, { term, lastLogIndex, lastLogTerm })
        assert(ctx.peer.send.notCalled)
      })
    }

    const setsTerm = ({ term, lastLogIndex, lastLogTerm }) => {
      context('the candidate’s term is ahead', () => {
        it('updates its term to that of the candidate', async ctx => {
          await ctx.follower.handleRequestVote(ctx.peer, term, { term, lastLogIndex, lastLogTerm })
          assert(ctx.state.setTerm.calledOnce)
          const { args: [value] } = ctx.state.setTerm.firstCall
          assert(value === term)
        })

        it('returns a promise for when the term is updated', async ctx => {
          let updated
          ctx.state.setTerm.returns(new Promise(resolve => updated = resolve))

          const p = ctx.follower.handleRequestVote(ctx.peer, term, { term, lastLogIndex, lastLogTerm })

          const probe = Symbol()
          updated(probe)

          assert(await p === probe)
        })
      })
    }

    const grantsVote = ({ term, lastLogIndex, lastLogTerm }) => {
      it('sets its term to that of the candidate, and votes', async ctx => {
        await ctx.follower.handleRequestVote(ctx.peer, term, { term, lastLogIndex, lastLogTerm })

        assert(ctx.state.setTermAndVote.calledOnce)
        const { args: [value, id] } = ctx.state.setTermAndVote.firstCall
        assert(value === term)
        assert(id === ctx.peer.id)
      })

      context('the follower was destroyed while persisting the state', () => {
        it('does not send a GrantVote message to the candidate', async ctx => {
          let persisted
          ctx.state.setTermAndVote.returns(new Promise(resolve => persisted = resolve))

          ctx.follower.handleRequestVote(ctx.peer, term, { term, lastLogIndex, lastLogTerm })
          ctx.follower.destroy()
          persisted()

          await Promise.resolve()
          assert(ctx.peer.send.notCalled)
        })
      })

      context('the follower was not destroyed while persisting the state', () => {
        it('sends a GrantVote message to the candidate', async ctx => {
          ctx.state._currentTerm.returns(term)
          await ctx.follower.handleRequestVote(ctx.peer, term, { term, lastLogIndex, lastLogTerm })

          assert(ctx.peer.send.calledOnce)
          const { args: [granted] } = ctx.peer.send.firstCall
          assert.deepStrictEqual(granted, { type: GrantVote, term })
        })
      })

      context('it does not receive other messages before the election timeout', () => {
        beforeEach(ctx => ctx.follower.start())

        it('does not yet become a candidate', async ctx => {
          await ctx.follower.handleRequestVote(ctx.peer, term, { term, lastLogIndex, lastLogTerm })

          ctx.clock.tick(ctx.electionTimeout)
          assert(ctx.follower.convertToCandidate.notCalled)
        })

        context('another election timeout passes', () => {
          it('becomes a candidate', async ctx => {
            await ctx.follower.handleRequestVote(ctx.peer, term, { term, lastLogIndex, lastLogTerm })

            ctx.clock.tick(ctx.electionTimeout)
            assert(ctx.follower.convertToCandidate.notCalled)

            ctx.clock.tick(ctx.electionTimeout)
            assert(ctx.follower.convertToCandidate.calledOnce)
          })
        })
      })
    }

    ;[
      { ok: true, condition: 'not yet voted', setup (ctx) { ctx.state._votedFor.returns(null) } },
      { ok: true, condition: 'has already voted for the candidate', setup (ctx) { ctx.state._votedFor.returns(ctx.peer.id) } },
      { ok: false, condition: 'has already voted for another candidate', setup (ctx) { ctx.state._votedFor.returns(ctx.peers[1]) } }
    ].forEach(({ ok, condition, setup }) => {
      context(`the follower has ${condition}`, () => {
        beforeEach(setup)

        context('the candidate’s log index is behind', () => {
          doesNotGrantVote({ term: 3, lastLogIndex: 1, lastLogTerm: 1 })
          setsTerm({ term: 3, lastLogIndex: 1, lastLogTerm: 1 })
        })

        context('the candidate’s log term is behind', () => {
          doesNotGrantVote({ term: 2, lastLogIndex: 2, lastLogTerm: 1 })
          setsTerm({ term: 3, lastLogIndex: 2, lastLogTerm: 1 })
        })

        ;[
          { condition: 'index is equal, as is its term', index: 2, term: 2 },
          { condition: 'index is equal, its term is ahead', index: 2, term: 2 },
          { condition: 'index is ahead, its term is equal', index: 3, term: 2 },
          { condition: 'index is ahead, its term is ahead', index: 3, term: 3 }
        ].forEach(({ condition, index: lastLogIndex, term: lastLogTerm }) => {
          context(`the candidate’s log ${condition}`, () => {
            if (ok) {
              grantsVote({ term: 3, lastLogIndex, lastLogTerm })
            } else {
              doesNotGrantVote({ term: 3, lastLogIndex, lastLogTerm })
            }
          })
        })
      })
    })
  })

  describe('#handleAppendEntries (peer, term, { prevLogIndex, prevLogTerm, entries, leaderCommit }))', () => {
    beforeEach(ctx => {
      ctx.state._currentTerm.returns(2)
    })

    context('the leader’s term is behind', () => {
      it('sends a RejectEntries message to the peer', ctx => {
        ctx.follower.handleAppendEntries(ctx.peer, 1, { term: 1 })

        assert(ctx.peer.send.calledOnce)
        const { args: [rejected] } = ctx.peer.send.firstCall
        assert.deepStrictEqual(rejected, { type: RejectEntries, term: 2 })
      })

      it('does not merge entries', async ctx => {
        // The other arguments should cause the entries to be merged, were it
        // not for the outdated term.
        await ctx.follower.handleAppendEntries(ctx.peer, 1, { term: 1, prevLogIndex: 0, prevLogTerm: 0, entries: [] })
        // Verify the entries were indeed rejected and no other messages were sent.
        assert(ctx.peer.send.calledOnce)
        const { args: [{ type }] } = ctx.peer.send.firstCall
        assert(type === RejectEntries)
      })
    })

    context('the leader is not sending its first entry', () => {
      context('the follower doesn’t have the entry that preceeds the first entry that was sent', () => {
        it('sends a RejectEntries message to the peer, without merging entries', async ctx => {
          ctx.log.getEntry.returns(undefined)
          await ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 1, prevLogTerm: 1, entries: [] })

          assert(ctx.peer.send.calledOnce)
          const { args: [rejected] } = ctx.peer.send.firstCall
          assert.deepStrictEqual(rejected, { type: RejectEntries, term: 2, conflictingIndex: 1 })
        })
      })

      context('the follower does have a preceeding entry, but it has the wrong term', () => {
        it('sends a RejectEntries message to the peer, without merging entries', async ctx => {
          ctx.log.getEntry.returns(new Entry(1, 2, Symbol()))
          await ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 1, prevLogTerm: 1, entries: [] })

          assert(ctx.peer.send.calledOnce)
          const { args: [rejected] } = ctx.peer.send.firstCall
          assert.deepStrictEqual(rejected, { type: RejectEntries, term: 2, conflictingIndex: 1 })
        })
      })

      context('the follower has the preceeding entry, with the right term', () => {
        it('merges the entries', ctx => {
          ctx.log.getEntry.returns(new Entry(1, 1, Symbol()))
          const entries = Symbol()
          ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 1, prevLogTerm: 1, entries, leaderCommit: 0 })

          assert(ctx.log.mergeEntries.calledOnce)
          const { args: [merged] } = ctx.log.mergeEntries.firstCall
          assert(merged === entries)
        })
      })
    })

    context('the leader is sending its first entry', () => {
      it('merges the entries', ctx => {
        const entries = Symbol()
        ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries, leaderCommit: 0 })

        assert(ctx.log.mergeEntries.calledOnce)
        const { args: [merged] } = ctx.log.mergeEntries.firstCall
        assert(merged === entries)
      })
    })

    context('entries are being merged', () => {
      context('it does not receive other messages before the election timeout', () => {
        beforeEach(ctx => ctx.follower.start())

        it('does not yet become a candidate', async ctx => {
          await ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })

          ctx.clock.tick(ctx.electionTimeout)
          assert(ctx.follower.convertToCandidate.notCalled)
        })

        context('another election timeout passes', () => {
          it('becomes a candidate', async ctx => {
            await ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })

            ctx.clock.tick(ctx.electionTimeout)
            assert(ctx.follower.convertToCandidate.notCalled)

            ctx.clock.tick(ctx.electionTimeout)
            assert(ctx.follower.convertToCandidate.calledOnce)
          })
        })
      })

      context('the leader’s term is ahead', () => {
        it('updates its term to that of the leader', ctx => {
          ctx.follower.handleAppendEntries(ctx.peer, 3, { term: 3, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })

          assert(ctx.state.setTerm.calledOnce)
          const { args: [term] } = ctx.state.setTerm.firstCall
          assert(term === 3)
        })

        context('the follower was destroyed while persisting the entries or state', () => {
          it('does not send an AcceptEntries message to the candidate', async ctx => {
            let persisted
            ctx.state.setTerm.returns(new Promise(resolve => persisted = resolve))

            ctx.follower.handleAppendEntries(ctx.peer, 3, { term: 3, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
            ctx.follower.destroy()
            persisted()

            await new Promise(resolve => setImmediate(resolve))
            assert(ctx.peer.send.notCalled)
          })
        })

        context('the follower was not destroyed while persisting the entries or state', () => {
          it('sends an AcceptEntries message to the candidate', async ctx => {
            ctx.state._currentTerm.returns(3)
            ctx.log._lastIndex.returns(1)
            await ctx.follower.handleAppendEntries(ctx.peer, 3, { term: 3, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })

            assert(ctx.peer.send.calledOnce)
            const { args: [accepted] } = ctx.peer.send.firstCall
            assert.deepStrictEqual(accepted, { type: AcceptEntries, term: 3, lastLogIndex: 1 })
          })
        })
      })

      context('the leader’s term is even with that of the follower', () => {
        it('does not update its term', ctx => {
          ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
          assert(ctx.state.setTerm.notCalled)
        })

        context('the follower was destroyed while persisting the entries', () => {
          it('does not send an AcceptEntries message to the candidate', async ctx => {
            let persisted
            ctx.log.mergeEntries.returns(new Promise(resolve => persisted = resolve))

            ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
            ctx.follower.destroy()
            persisted()

            await new Promise(resolve => setImmediate(resolve))
            assert(ctx.peer.send.notCalled)
          })
        })

        context('the follower was not destroyed while persisting the entries', () => {
          it('sends an AcceptEntries message to the candidate', async ctx => {
            ctx.log._lastIndex.returns(1)
            await ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })

            assert(ctx.peer.send.calledOnce)
            const { args: [accepted] } = ctx.peer.send.firstCall
            assert.deepStrictEqual(accepted, { type: AcceptEntries, term: 2, lastLogIndex: 1 })
          })
        })
      })

      context('the leader’s commit index…', () => {
        context('is ahead', () => {
          it('commits the log up to the leader’s index', ctx => {
            ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 1 })
            assert(ctx.log.commit.calledOnce)
            const { args: [commit] } = ctx.log.commit.firstCall
            assert(commit === 1)
          })

          it('stores the leader’s commit index', async ctx => {
            await ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 1 })
            assert(ctx.log.commit.calledOnce)

            // No second commit if the index is the same
            await ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 1 })
            assert(ctx.log.commit.calledOnce)

            // Another commit if the index is higher again
            await ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 2 })
            assert(ctx.log.commit.calledTwice)
          })
        })

        context('is behind', () => {
          beforeEach(async ctx => {
            await ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 10 })
            ctx.log.commit.resetHistory()
          })

          it('does not commit the log', async ctx => {
            await ctx.follower.handleAppendEntries(ctx.peer, 2, { term: 2, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 5 })
            assert(ctx.log.commit.notCalled)
          })
        })
      })
    })
  })
})
