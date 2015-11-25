import { resolve } from 'path'

import { after, afterEach, before, beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import { install as installClock } from 'lolex'
import sinon from 'sinon'

import {
  setupConstructors,
  testFollowerConversion,
  testInputConsumerDestruction, testInputConsumerInstantiation, testInputConsumerStart,
  testMessageHandlerMapping,
  testSchedulerDestruction, testSchedulerInstantiation
} from './support/role-tests'
import { stubLog, stubMessages, stubPeer, stubState } from './support/stub-helpers'
import { getReason } from './support/utils'

import {
  AppendEntries, RejectEntries, AcceptEntries,
  RequestVote, DenyVote,
  Noop
} from '../lib/symbols'

import Entry from '../lib/Entry'

describe('roles/Leader', () => {
  before(ctx => ctx.clock = installClock(0, ['setInterval', 'clearInterval']))
  after(ctx => ctx.clock.uninstall())

  setupConstructors(resolve(__dirname, '../lib/roles/Leader'))

  beforeEach(ctx => {
    const heartbeatInterval = ctx.heartbeatInterval = 10
    const state = ctx.state = stubState()
    const log = ctx.log = stubLog()
    const peers = ctx.peers = [ctx.peer = stubPeer(), stubPeer(), stubPeer()]
    const nonPeerReceiver = ctx.nonPeerReceiver = sinon.stub({ messages: stubMessages() })
    const crashHandler = ctx.crashHandler = sinon.stub()
    const convertToCandidate = ctx.convertToCandidate = sinon.stub()
    const convertToFollower = ctx.convertToFollower = sinon.stub()

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

    ctx.leader = new ctx.Leader({ heartbeatInterval, state, log, peers, nonPeerReceiver, crashHandler, convertToCandidate, convertToFollower })
  })

  afterEach(ctx => !ctx.leader.destroyed && ctx.leader.destroy())

  const supportAppend = ctx => {
    // Stub correct appendValue() behavior.
    ctx.log.appendValue = (_, value) => {
      const index = ctx.log.lastIndex + 1
      // Ensure the log's last index reflects the correct value.
      ctx.log._lastIndex.returns(index)
      return Promise.resolve(new Entry(index, 1, value))
    }

    // The appendValue() behavior will ensure the internal leader state is
    // in the correct order. The scheduler's behavior is unnecessary so yield
    // immediately.
    sinon.stub(ctx.leader.scheduler, 'asap').callsArg(1)

    // Stub correct commit() behavior.
    ctx.log.commit = sinon.spy(index => {
      const appended = ctx.appendedValues.find(({ index: entryIndex }) => entryIndex === index)
      return appended ? Promise.resolve(appended.value) : Promise.reject(new Error(`Can't find appended value for index ${index}`))
    })

    // Hold the appended values, their indexes and the promise for when
    // they're committed.
    ctx.appendedValues = []

    ctx.leaderAppend = async values => {
      for (const value of values) {
        const promise = ctx.leader.append(value)
        ctx.appendedValues.push({
          value,
          promise,
          index: ctx.log.lastIndex
        })
      }

      // Wait for the internal leader state to be updated.
      await Promise.resolve()
    }
  }

  const wasHeartbeat = function (call, { prevLogIndex: expectedPrevLogIndex, leaderCommit: expectedLeaderCommit }) {
    const { type, term, prevLogIndex, prevLogTerm, leaderCommit, entries } = call.args[0]
    assert(type === AppendEntries)
    assert(term === 2)
    assert(prevLogIndex === expectedPrevLogIndex)
    assert.deepStrictEqual(prevLogTerm, { index: expectedPrevLogIndex })
    assert(leaderCommit === expectedLeaderCommit)
    assert.deepStrictEqual(entries, [])
  }

  const wasEntries = function (call, { prevLogIndex: expectedPrevLogIndex, leaderCommit: expectedLeaderCommit, entryIndexes }) {
    const { type, term, prevLogIndex, prevLogTerm, leaderCommit, entries } = call.args[0]
    assert(type === AppendEntries)
    assert(term === 2)
    assert(prevLogIndex === expectedPrevLogIndex)
    assert.deepStrictEqual(prevLogTerm, { index: expectedPrevLogIndex })
    assert(leaderCommit === expectedLeaderCommit)
    assert.deepStrictEqual(entries, entryIndexes)
  }

  describe('constructor ({ heartbeatInterval, state, log, peers, nonPeerReceiver, crashHandler, convertToCandidate, convertToFollower })', () => {
    testInputConsumerInstantiation('leader', ctx => ctx.leader, ctx => ctx.crashHandler)
    testSchedulerInstantiation(ctx => ctx.leader, ctx => ctx.crashHandler)
  })

  describe('#start ()', () => {
    it('starts the heartbeat timer', ctx => {
      const spy = sinon.spy(ctx.leader, 'sendHeartbeat')
      ctx.leader.start()

      ctx.clock.tick(ctx.heartbeatInterval)
      sinon.assert.calledOnce(spy)

      ctx.clock.tick(ctx.heartbeatInterval)
      sinon.assert.calledTwice(spy)
    })

    it('appends a Noop entry', ctx => {
      const spy = sinon.spy(ctx.leader, 'append')
      ctx.leader.start()

      sinon.assert.calledOnce(spy)
      sinon.assert.calledWithExactly(spy, Noop)
    })

    testInputConsumerStart(ctx => ctx.leader)
  })

  describe('#destroy ()', () => {
    it('clears the heartbeat timer', ctx => {
      const spy = sinon.spy(ctx.leader, 'sendHeartbeat') // spy on the method called by the timer

      ctx.leader.start()
      ctx.leader.destroy() // should prevent the timer from triggering
      ctx.clock.tick(ctx.heartbeatInterval) // timer should fire now, if not cleared
      sinon.assert.notCalled(spy) // should not be called again
    })

    testInputConsumerDestruction(ctx => ctx.leader)
    testSchedulerDestruction(ctx => ctx.leader)
  })

  // The implementation has an option to skip sending a heartbeat. This is
  // tested in the append() test, since this method sets the corresponding flag.
  describe('#sendHeartbeat ()', () => {
    it('sends a heartbeat message to each follower', ctx => {
      ctx.leader.sendHeartbeat()

      for (const peer of ctx.peers) {
        sinon.assert.calledOnce(peer.send)
        wasHeartbeat(peer.send.getCall(0), { prevLogIndex: 2, leaderCommit: 0 })
      }
    })

    it('forgoes the scheduler', ctx => {
      const spy = sinon.spy(ctx.leader.scheduler, 'asap')
      ctx.leader.sendHeartbeat()
      sinon.assert.notCalled(spy)
    })
  })

  describe('#handleMessage (peer, message)', () => {
    testFollowerConversion('leader', ctx => ctx.leader)

    testMessageHandlerMapping(ctx => [ctx.leader, ctx.peer], [
      { type: RequestVote, label: 'RequestVote', method: 'handleRequestVote' },
      { type: RejectEntries, label: 'RejectEntries', method: 'handleRejectEntries' },
      { type: AcceptEntries, label: 'AcceptEntries', method: 'handleAcceptEntries' }
    ])
  })

  describe('#handleRequestVote (peer, term)', () => {
    context('the term is older', () => {
      it('sends a DenyVote message to the candidate', ctx => {
        ctx.leader.handleRequestVote(ctx.peer, 1, { term: 1 })

        sinon.assert.calledOnce(ctx.peer.send)
        const { args: [denied] } = ctx.peer.send.getCall(0)
        assert.deepStrictEqual(denied, { type: DenyVote, term: 2 })
      })

      it('does not send an AppendEntries message to the candidate', ctx => {
        ctx.leader.handleRequestVote(ctx.peer, 1, { term: 1 })

        sinon.assert.calledOnce(ctx.peer.send)
        const { args: [{ type }] } = ctx.peer.send.getCall(0)
        assert(type !== AppendEntries)
      })
    })

    context('the term is current with the leader', () => {
      context('the candidate is a known peer', () => {
        it('sends a heartbeat message to the candidate', ctx => {
          ctx.leader.handleRequestVote(ctx.peer, 2, { term: 2 })
          sinon.assert.calledOnce(ctx.peer.send)
          wasHeartbeat(ctx.peer.send.getCall(0), { prevLogIndex: 2, leaderCommit: 0 })
        })
      })

      context('the candidate is not a known peer', () => {
        it('does not send an AppendEntries message to the candidate', ctx => {
          ctx.leader.handleRequestVote(stubPeer(), 2, { term: 2 })
          sinon.assert.notCalled(ctx.peer.send)
        })
      })
    })
  })

  describe('#handleRejectEntries (peer, term, { conflictingIndex })', () => {
    beforeEach(ctx => {
      // The log was initialized with a last index of 2. This gives an initial
      // matchIndex for each peer of 0, and nextIndex of 3. For testing purposes
      // the first peer should converge.

      // First pretend to append another entry. This allows converging the peer
      // on that entry.
      ctx.log._lastIndex.returns(3)
      // Next pretend to accept these entries. This sets the matchIndex to 3 and
      // the nextIndex to 4.
      ctx.leader.handleAcceptEntries(ctx.peer, 1, { lastLogIndex: 3 })
    })

    context('the peer is not known', () => {
      it('does not send an AppendEntries message to the peer', ctx => {
        ctx.leader.handleRejectEntries(stubPeer(), 1, {})
        sinon.assert.notCalled(ctx.peer.send)
      })
    })

    context('the peer is known', () => {
      ;[
        { condition: 'equal to the matchIndex', conflictingIndex: 3 },
        { condition: 'less than the matchIndex', conflictingIndex: 2 },
        { condition: 'equal to the nextIndex', conflictingIndex: 4 },
        { condition: 'greater than the nextIndex', conflictingIndex: 5 }
      ].forEach(({ condition, conflictingIndex }) => {
        context(`conflictingIndex is ${condition} for the peer`, () => {
          it('does not send an AppendEntries message to the peer', ctx => {
            ctx.leader.handleRejectEntries(ctx.peer, 1, { conflictingIndex })
            sinon.assert.notCalled(ctx.peer.send)
          })
        })
      })

      context('conflictingIndex is greater than the matchIndex for the peer, and less than the nextIndex for the peer', () => {
        beforeEach(ctx => {
          // The second peer still has the initial matchIndex of 0, and
          // nextIndex of 3.
          ctx.leader.handleRejectEntries(ctx.peers[1], 1, { conflictingIndex: 1 })
        })

        it('sends a heartbeat message to the peer', ctx => {
          sinon.assert.calledOnce(ctx.peers[1].send)
          wasHeartbeat(ctx.peers[1].send.getCall(0), { prevLogIndex: 0, leaderCommit: 0 })
        })

        it('sets the nextIndex for the peer to the conflictingIndex value', ctx => {
          // If the same conflictingIndex is received it must now equal the
          // nextIndex for the peer, which means no AppendEntries message should
          // be sent as a result.
          ctx.peers[1].send.reset()
          ctx.leader.handleRejectEntries(ctx.peers[1], 1, { conflictingIndex: 1 })
          sinon.assert.notCalled(ctx.peers[1].send)
        })
      })
    })
  })

  describe('#handleAcceptEntries (peer, term, { lastLogIndex })', () => {
    context('the peer is not known', () => {
      it('does nothing (does not crash)', ctx => {
        assert.doesNotThrow(() => ctx.leader.handleAcceptEntries(stubPeer(), 1, {}))
      })
    })

    context('the peer is known', () => {
      beforeEach(ctx => sinon.spy(ctx.leader, 'markReplication'))

      // Remember that the log was initialized with a last index of 2. This
      // gives an initial matchIndex for each peer of 0, and nextIndex of 3.
      context('lastLogIndex is equal to or greater than the nextIndex for the peer', () => {
        it('marks replication for entries in the range', ctx => {
          ctx.leader.handleAcceptEntries(ctx.peer, 1, { lastLogIndex: 3 })
          sinon.assert.calledOnce(ctx.leader.markReplication)
          sinon.assert.calledWithExactly(ctx.leader.markReplication, 3, 3)
        })

        it('updates nextIndex for the peer', ctx => {
          // nextIndex should be set to lastLogIndex + 1. If that's the case
          // then accepting the same lastLogIndex a second time should not
          // result in any entries being marked as replicated again.
          ctx.leader.handleAcceptEntries(ctx.peer, 1, { lastLogIndex: 3 })
          sinon.assert.calledOnce(ctx.leader.markReplication)

          ctx.leader.handleAcceptEntries(ctx.peer, 1, { lastLogIndex: 3 })
          sinon.assert.calledOnce(ctx.leader.markReplication)
        })

        it('updates matchIndex for the peer', ctx => {
          // matchIndex should be set to lastLogIndex. If that's the case then
          // rejecting an earlier lastLogTerm should not result in an
          // AppendEntries message being sent to the peer.
          ctx.leader.handleAcceptEntries(ctx.peer, 1, { lastLogIndex: 3 })
          ctx.peer.send.reset()

          ctx.leader.handleRejectEntries(ctx.peer, 1, { conflictingIndex: 2 })
          sinon.assert.notCalled(ctx.peer.send)
        })
      })

      context('nextIndex (after potentially updating) is within the log boundary', () => {
        it('sends remaining entries to the peer', ctx => {
          // The second peer still has the initial matchIndex of 0, and
          // nextIndex of 3. Converge so nextIndex is 1.
          const peer = ctx.peers[1]
          ctx.leader.handleRejectEntries(peer, 1, { conflictingIndex: 1 })
          peer.send.reset()

          // Now pretend to accept the entry at index 1.
          ctx.leader.handleAcceptEntries(peer, 1, { lastLogIndex: 1 })
          sinon.assert.calledOnce(peer.send)
          wasEntries(peer.send.getCall(0), { prevLogIndex: 1, leaderCommit: 0, entryIndexes: [2] })

          // Repeat. The nextIndex will now be 2 so it doesn't need updating.
          // It's still smaller than the last index of the log though, so the
          // last entry will be sent.
          ctx.leader.handleAcceptEntries(peer, 1, { lastLogIndex: 1 })
          sinon.assert.calledTwice(peer.send)
          wasEntries(peer.send.getCall(1), { prevLogIndex: 1, leaderCommit: 0, entryIndexes: [2] })
        })
      })
    })
  })

  describe('#markReplication (startIndex, endIndex)', () => {
    beforeEach(async ctx => {
      supportAppend(ctx)
      // Set up three entries that need to be marked as replicated.
      await ctx.leaderAppend([Symbol('first'), Symbol('second'), Symbol('third')])
    })

    // Note that the leader has three followers. An entry should be replicated
    // to two followers before a majority of the cluster contains the entry.
    context('an entry within the range has sufficiently replicated', () => {
      it('commits the entry', ctx => {
        const [first] = ctx.appendedValues

        ctx.leader.markReplication(first.index, first.index)
        sinon.assert.notCalled(ctx.log.commit)

        ctx.leader.markReplication(first.index, first.index)
        sinon.assert.calledOnce(ctx.log.commit)
        sinon.assert.calledWithExactly(ctx.log.commit, first.index)
      })
    })

    context('subsequent entries within the range have sufficiently replicated', () => {
      it('commits both entries, in order', ctx => {
        const [first, second] = ctx.appendedValues
        ctx.leader.markReplication(first.index, second.index)
        sinon.assert.notCalled(ctx.log.commit)

        ctx.leader.markReplication(first.index, second.index)
        sinon.assert.calledTwice(ctx.log.commit)
        assert(ctx.log.commit.getCall(0).args[0] === first.index)
        assert(ctx.log.commit.getCall(1).args[0] === second.index)
      })
    })

    context('an entry before the startIndex has not sufficiently replicated', () => {
      it('does not commit any entries', ctx => {
        const [, second] = ctx.appendedValues
        ctx.leader.markReplication(second.index, second.index)
        sinon.assert.notCalled(ctx.log.commit)
        ctx.leader.markReplication(second.index, second.index)
        sinon.assert.notCalled(ctx.log.commit)
      })
    })

    context('when an entry is committed', () => {
      it('updates the commit index to be the index of that entry', ctx => {
        const [first] = ctx.appendedValues
        ctx.leader.markReplication(first.index, first.index)
        ctx.leader.markReplication(first.index, first.index)

        // Send a heartbeat message. It'll include the commit index of the
        // leader.
        ctx.peer.send.reset()
        ctx.leader.sendHeartbeat() // First heartbeat is skipped
        ctx.leader.sendHeartbeat()
        wasHeartbeat(ctx.peer.send.getCall(0), { prevLogIndex: first.index - 1, leaderCommit: first.index })
      })
    })
  })

  describe('#append (value)', () => {
    it('returns a promise', ctx => {
      assert(ctx.leader.append() instanceof Promise)
    })

    it('uses the scheduler', ctx => {
      // Only checks whether the scheduler is used. Not a perfect test since
      // it doesn't confirm that the operation is actually gated by the
      // scheduler.
      const spy = sinon.spy(ctx.leader.scheduler, 'asap')
      ctx.leader.append()
      sinon.assert.calledOnce(spy)
    })

    context('the scheduler is aborted', () => {
      it('rejects the returned promise', async ctx => {
        // Mimick abort by calling the abortHandler
        sinon.stub(ctx.leader.scheduler, 'asap').callsArg(0)
        assert(await getReason(ctx.leader.append()) instanceof Error)
      })
    })

    it('appends the value to the log', ctx => {
      ctx.log.appendValue.returns(new Promise(() => {}))
      const value = Symbol()
      ctx.leader.append(value)
      sinon.assert.calledOnce(ctx.log.appendValue)
      sinon.assert.calledWithExactly(ctx.log.appendValue, 2, value)
    })

    context('the leader is destroyed while appending the value', () => {
      it('rejects the returned promise', async ctx => {
        let appended
        ctx.log.appendValue.returns(new Promise(resolve => appended = resolve))

        const p = ctx.leader.append()
        ctx.leader.destroy()
        appended()

        assert(await getReason(p) instanceof Error)
      })
    })

    context('the leader is not destroyed', () => {
      beforeEach(async ctx => {
        // The peers still have an initial matchIndex of 0, and nextIndex of 3.
        // Converge so nextIndex is 1.
        for (const peer of ctx.peers) {
          ctx.leader.handleRejectEntries(peer, 1, { conflictingIndex: 1 })
          peer.send.reset()
        }

        supportAppend(ctx)
        await ctx.leaderAppend([Symbol()])
      })

      it('sends new entries to each peer', ctx => {
        for (const peer of ctx.peers) {
          sinon.assert.calledOnce(peer.send)
          // Entry's at index 1 and 2 still needed to be sent. Entry 3 is the
          // new one.
          wasEntries(peer.send.getCall(0), { prevLogIndex: 0, leaderCommit: 0, entryIndexes: [1, 2, 3] })
        }
      })

      it('does not send the next heartbeat message', ctx => {
        for (const peer of ctx.peers) {
          peer.send.reset()
        }

        ctx.leader.start()
        ctx.clock.tick(ctx.heartbeatInterval)
        for (const peer of ctx.peers) {
          sinon.assert.notCalled(peer.send)
        }
      })

      context('another heartbeat interval passes', () => {
        it('sends the heartbeat message', ctx => {
          for (const peer of ctx.peers) {
            peer.send.reset()
          }

          ctx.leader.start()
          ctx.clock.tick(ctx.heartbeatInterval)
          for (const peer of ctx.peers) {
            sinon.assert.notCalled(peer.send)
          }

          ctx.clock.tick(ctx.heartbeatInterval)
          for (const peer of ctx.peers) {
            sinon.assert.calledOnce(peer.send)
            wasHeartbeat(peer.send.getCall(0), { prevLogIndex: 0, leaderCommit: 0 })
          }
        })
      })
    })

    context('the entry is committed', () => {
      beforeEach(ctx => supportAppend(ctx))

      it('fulfills the returned promise with the commit result', async ctx => {
        const value = Symbol()
        await ctx.leaderAppend([value])

        const [first] = ctx.appendedValues
        // As per the markReplication() tests, two marks are needed.
        ctx.leader.markReplication(first.index, first.index)
        ctx.leader.markReplication(first.index, first.index)

        // As per supportAppend(), the promise is fulfilled with the original
        // value when committed.
        assert(await first.promise === value)
      })
    })
  })
})
