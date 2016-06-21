import { resolve } from 'path'

import { after, afterEach, before, beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import { install as installClock } from 'lolex'
import { spy, stub } from 'sinon'

import {
  AppendEntries, RejectEntries, AcceptEntries,
  RequestVote, DenyVote,
  Noop
} from '../lib/symbols'

import Entry from '../lib/Entry'

import {
  setupConstructors,
  testFollowerConversion,
  testInputConsumerDestruction, testInputConsumerInstantiation, testInputConsumerStart,
  testMessageHandlerMapping,
  testSchedulerDestruction, testSchedulerInstantiation
} from './support/role-tests'
import { stubLog, stubMessages, stubPeer, stubState, stubTimers } from './support/stub-helpers'
import { getReason } from './support/utils'

describe('roles/Leader', () => {
  before(ctx => {
    ctx.clock = installClock(0, ['setInterval', 'clearInterval'])
  })
  after(ctx => ctx.clock.uninstall())

  setupConstructors(resolve(__dirname, '../lib/roles/Leader'))

  beforeEach(ctx => {
    const convertToCandidate = ctx.convertToCandidate = stub()
    const convertToFollower = ctx.convertToFollower = stub()
    const crashHandler = ctx.crashHandler = stub()
    const heartbeatInterval = ctx.heartbeatInterval = 10
    const log = ctx.log = stubLog()
    const nonPeerReceiver = ctx.nonPeerReceiver = stub({ messages: stubMessages() })
    const peers = ctx.peers = [ctx.peer = stubPeer(), stubPeer(), stubPeer()]
    const state = ctx.state = stubState()

    const { clock, timers } = stubTimers()
    ctx.clock = clock

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

    ctx.leader = new ctx.Leader({ convertToCandidate, convertToFollower, crashHandler, heartbeatInterval, log, nonPeerReceiver, peers, state, timers })
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
    stub(ctx.leader.scheduler, 'asap').callsArg(1)

    // Stub correct commit() behavior.
    ctx.log.commit = spy(index => {
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
    const { args: [{ type, term, prevLogIndex, prevLogTerm, leaderCommit, entries }] } = call
    assert(type === AppendEntries)
    assert(term === 2)
    assert(prevLogIndex === expectedPrevLogIndex)
    assert.deepStrictEqual(prevLogTerm, { index: expectedPrevLogIndex })
    assert(leaderCommit === expectedLeaderCommit)
    assert.deepStrictEqual(entries, [])
  }

  const wasEntries = function (call, { prevLogIndex: expectedPrevLogIndex, leaderCommit: expectedLeaderCommit, entryIndexes }) {
    const { args: [{ type, term, prevLogIndex, prevLogTerm, leaderCommit, entries }] } = call
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
      spy(ctx.leader, 'sendHeartbeat')
      ctx.leader.start()

      ctx.clock.tick(ctx.heartbeatInterval)
      assert(ctx.leader.sendHeartbeat.calledOnce)

      ctx.clock.tick(ctx.heartbeatInterval)
      assert(ctx.leader.sendHeartbeat.calledTwice)
    })

    it('appends a Noop entry', ctx => {
      spy(ctx.leader, 'append')
      ctx.leader.start()

      assert(ctx.leader.append.calledOnce)
      const { args: [value] } = ctx.leader.append.firstCall
      assert(value === Noop)
    })

    testInputConsumerStart(ctx => ctx.leader)
  })

  describe('#destroy ()', () => {
    it('clears the heartbeat timer', ctx => {
      spy(ctx.leader, 'sendHeartbeat') // spy on the method called by the timer

      ctx.leader.start()
      ctx.leader.destroy() // should prevent the timer from triggering
      ctx.clock.tick(ctx.heartbeatInterval) // timer should fire now, if not cleared
      assert(ctx.leader.sendHeartbeat) // should not be called agai.notCalledn
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
        assert(peer.send.calledOnce)
        wasHeartbeat(peer.send.firstCall, { prevLogIndex: 2, leaderCommit: 0 })
      }
    })

    it('forgoes the scheduler', ctx => {
      spy(ctx.leader.scheduler, 'asap')
      ctx.leader.sendHeartbeat()
      assert(ctx.leader.scheduler.asap.notCalled)
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

        assert(ctx.peer.send.calledOnce)
        const { args: [denied] } = ctx.peer.send.firstCall
        assert.deepStrictEqual(denied, { type: DenyVote, term: 2 })
      })

      it('does not send an AppendEntries message to the candidate', ctx => {
        ctx.leader.handleRequestVote(ctx.peer, 1, { term: 1 })

        assert(ctx.peer.send.calledOnce)
        const { args: [{ type }] } = ctx.peer.send.firstCall
        assert(type !== AppendEntries)
      })
    })

    context('the term is current with the leader', () => {
      context('the candidate is a known peer', () => {
        it('sends a heartbeat message to the candidate', ctx => {
          ctx.leader.handleRequestVote(ctx.peer, 2, { term: 2 })
          assert(ctx.peer.send.calledOnce)
          wasHeartbeat(ctx.peer.send.firstCall, { prevLogIndex: 2, leaderCommit: 0 })
        })
      })

      context('the candidate is not a known peer', () => {
        it('does not send an AppendEntries message to the candidate', ctx => {
          ctx.leader.handleRequestVote(stubPeer(), 2, { term: 2 })
          assert(ctx.peer.send.notCalled)
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
        assert(ctx.peer.send.notCalled)
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
            assert(ctx.peer.send.notCalled)
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
          assert(ctx.peers[1].send.calledOnce)
          wasHeartbeat(ctx.peers[1].send.firstCall, { prevLogIndex: 0, leaderCommit: 0 })
        })

        it('sets the nextIndex for the peer to the conflictingIndex value', ctx => {
          // If the same conflictingIndex is received it must now equal the
          // nextIndex for the peer, which means no AppendEntries message should
          // be sent as a result.
          ctx.peers[1].send.resetHistory()
          ctx.leader.handleRejectEntries(ctx.peers[1], 1, { conflictingIndex: 1 })
          assert(ctx.peers[1].send.notCalled)
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
      beforeEach(ctx => spy(ctx.leader, 'markReplication'))

      // Remember that the log was initialized with a last index of 2. This
      // gives an initial matchIndex for each peer of 0, and nextIndex of 3.
      context('lastLogIndex is equal to or greater than the nextIndex for the peer', () => {
        it('marks replication for entries in the range', ctx => {
          ctx.leader.handleAcceptEntries(ctx.peer, 1, { lastLogIndex: 3 })
          assert(ctx.leader.markReplication.calledOnce)
          const { args: [start, end] } = ctx.leader.markReplication.firstCall
          assert(start === 3)
          assert(end === 3)
        })

        it('updates nextIndex for the peer', ctx => {
          // nextIndex should be set to lastLogIndex + 1. If that's the case
          // then accepting the same lastLogIndex a second time should not
          // result in any entries being marked as replicated again.
          ctx.leader.handleAcceptEntries(ctx.peer, 1, { lastLogIndex: 3 })
          assert(ctx.leader.markReplication.calledOnce)

          ctx.leader.handleAcceptEntries(ctx.peer, 1, { lastLogIndex: 3 })
          assert(ctx.leader.markReplication.calledOnce)
        })

        it('updates matchIndex for the peer', ctx => {
          // matchIndex should be set to lastLogIndex. If that's the case then
          // rejecting an earlier lastLogTerm should not result in an
          // AppendEntries message being sent to the peer.
          ctx.leader.handleAcceptEntries(ctx.peer, 1, { lastLogIndex: 3 })
          ctx.peer.send.resetHistory()

          ctx.leader.handleRejectEntries(ctx.peer, 1, { conflictingIndex: 2 })
          assert(ctx.peer.send.notCalled)
        })
      })

      context('nextIndex (after potentially updating) is within the log boundary', () => {
        it('sends remaining entries to the peer', ctx => {
          // The second peer still has the initial matchIndex of 0, and
          // nextIndex of 3. Converge so nextIndex is 1.
          const peer = ctx.peers[1]
          ctx.leader.handleRejectEntries(peer, 1, { conflictingIndex: 1 })
          peer.send.resetHistory()

          // Now pretend to accept the entry at index 1.
          ctx.leader.handleAcceptEntries(peer, 1, { lastLogIndex: 1 })
          assert(peer.send.calledOnce)
          wasEntries(peer.send.firstCall, { prevLogIndex: 1, leaderCommit: 0, entryIndexes: [2] })

          // Repeat. The nextIndex will now be 2 so it doesn't need updating.
          // It's still smaller than the last index of the log though, so the
          // last entry will be sent.
          ctx.leader.handleAcceptEntries(peer, 1, { lastLogIndex: 1 })
          assert(peer.send.calledTwice)
          wasEntries(peer.send.secondCall, { prevLogIndex: 1, leaderCommit: 0, entryIndexes: [2] })
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
        assert(ctx.log.commit.notCalled)

        ctx.leader.markReplication(first.index, first.index)
        assert(ctx.log.commit.calledOnce)
        const { args: [index] } = ctx.log.commit.firstCall
        assert(index === first.index)
      })
    })

    context('subsequent entries within the range have sufficiently replicated', () => {
      it('commits both entries, in order', ctx => {
        const [first, second] = ctx.appendedValues
        ctx.leader.markReplication(first.index, second.index)
        assert(ctx.log.commit.notCalled)

        ctx.leader.markReplication(first.index, second.index)
        assert(ctx.log.commit.calledTwice)
        const { args: [[firstIndex], [secondIndex]] } = ctx.log.commit
        assert(firstIndex === first.index)
        assert(secondIndex === second.index)
      })
    })

    context('an entry before the startIndex has not sufficiently replicated', () => {
      it('does not commit any entries', ctx => {
        const [, second] = ctx.appendedValues
        ctx.leader.markReplication(second.index, second.index)
        assert(ctx.log.commit.notCalled)
        ctx.leader.markReplication(second.index, second.index)
        assert(ctx.log.commit.notCalled)
      })
    })

    context('when an entry is committed', () => {
      it('updates the commit index to be the index of that entry', ctx => {
        const [first] = ctx.appendedValues
        ctx.leader.markReplication(first.index, first.index)
        ctx.leader.markReplication(first.index, first.index)

        // Send a heartbeat message. It'll include the commit index of the
        // leader.
        ctx.peer.send.resetHistory()
        ctx.leader.sendHeartbeat() // First heartbeat is skipped
        ctx.leader.sendHeartbeat()
        wasHeartbeat(ctx.peer.send.firstCall, { prevLogIndex: first.index - 1, leaderCommit: first.index })
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
      spy(ctx.leader.scheduler, 'asap')
      ctx.leader.append()
      assert(ctx.leader.scheduler.asap.calledOnce)
    })

    context('the scheduler is aborted', () => {
      it('rejects the returned promise', async ctx => {
        // Mimick abort by calling the abortHandler
        stub(ctx.leader.scheduler, 'asap').callsArg(0)
        assert(await getReason(ctx.leader.append()) instanceof Error)
      })
    })

    it('appends the value to the log', ctx => {
      ctx.log.appendValue.returns(new Promise(() => {}))
      const value = Symbol()
      ctx.leader.append(value)
      assert(ctx.log.appendValue.calledOnce)
      const { args: [term, appended] } = ctx.log.appendValue.firstCall
      assert(term === 2)
      assert(appended === value)
    })

    context('the leader is destroyed while appending the value', () => {
      it('rejects the returned promise', async ctx => {
        let appended
        ctx.log.appendValue.returns(new Promise(resolve => {
          appended = resolve
        }))

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
          peer.send.resetHistory()
        }

        supportAppend(ctx)
        await ctx.leaderAppend([Symbol()])
      })

      it('sends new entries to each peer', ctx => {
        for (const peer of ctx.peers) {
          assert(peer.send.calledOnce)
          // Entry's at index 1 and 2 still needed to be sent. Entry 3 is the
          // new one.
          wasEntries(peer.send.firstCall, { prevLogIndex: 0, leaderCommit: 0, entryIndexes: [1, 2, 3] })
        }
      })

      it('does not send the next heartbeat message', ctx => {
        for (const peer of ctx.peers) {
          peer.send.resetHistory()
        }

        ctx.leader.start()
        ctx.clock.tick(ctx.heartbeatInterval)
        for (const peer of ctx.peers) {
          assert(peer.send.notCalled)
        }
      })

      context('another heartbeat interval passes', () => {
        it('sends the heartbeat message', ctx => {
          for (const peer of ctx.peers) {
            peer.send.resetHistory()
          }

          ctx.leader.start()
          ctx.clock.tick(ctx.heartbeatInterval)
          for (const peer of ctx.peers) {
            assert(peer.send.notCalled)
          }

          ctx.clock.tick(ctx.heartbeatInterval)
          for (const peer of ctx.peers) {
            assert(peer.send.calledOnce)
            wasHeartbeat(peer.send.firstCall, { prevLogIndex: 0, leaderCommit: 0 })
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
