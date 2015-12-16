import { before, beforeEach, describe, context, it } from '!mocha'
import assert from 'power-assert'
import proxyquire from '!proxyquire'
import { spy, stub } from 'sinon'

import { stubState } from '../support/stub-helpers'
import { getReason } from '../support/utils'

describe('Raft', () => {
  before(ctx => {
    ctx.Candidate = spy(() => stub({ destroy () {}, start () {} }))
    ctx.Follower = spy(() => stub({ destroy () {}, start () {} }))
    ctx.Leader = spy(() => stub({ destroy () {}, start () {}, append () {} }))

    ctx.Log = spy(() => stub({ replace () {}, close () {}, destroy () {} }))
    ctx.LogEntryApplier = spy(() => stub())
    ctx.State = spy(() => stubState())

    ctx.NonPeerReceiver = spy(() => stub())
    ctx.Peer = spy(() => stub())

    ctx.Raft = proxyquire('lib/Raft', {
      './roles/Candidate': function (...args) { return ctx.Candidate(...args) },
      './roles/Follower': function (...args) { return ctx.Follower(...args) },
      './roles/Leader': function (...args) { return ctx.Leader(...args) },

      './Log': function (...args) { return ctx.Log(...args) },
      './LogEntryApplier': function (...args) { return ctx.LogEntryApplier(...args) },
      './State': function (...args) { return ctx.State(...args) },

      './NonPeerReceiver': function (...args) { return ctx.NonPeerReceiver(...args) },
      './Peer': function (...args) { return ctx.Peer(...args) }
    })['default']
  })

  beforeEach(ctx => {
    ctx.Candidate.reset()
    ctx.Follower.reset()
    ctx.Leader.reset()

    ctx.Log.reset()
    ctx.LogEntryApplier.reset()
    ctx.State.reset()

    ctx.NonPeerReceiver.reset()
    ctx.Peer.reset()

    const id = ctx.id = Symbol()
    const electionTimeoutWindow = ctx.electionTimeoutWindow = [1000, 2000]
    const heartbeatInterval = ctx.heartbeatInterval = Symbol()
    const persistState = ctx.persistState = Symbol()
    const persistEntries = ctx.persistEntries = Symbol()
    const applyEntry = ctx.applyEntry = Symbol()
    const crashHandler = ctx.crashHandler = Symbol()
    const emitEvent = ctx.emitEvent = spy()

    ctx.raft = new ctx.Raft({ id, electionTimeoutWindow, heartbeatInterval, persistState, persistEntries, applyEntry, crashHandler, emitEvent })
    spy(ctx.raft, 'becomeLeader')
    spy(ctx.raft, 'convertToCandidate')
    spy(ctx.raft, 'convertToFollower')
  })

  const destroyCurrentRole = method => {
    context('there is a current role', () => {
      it('destroys the role', ctx => {
        ctx.raft.becomeLeader()
        ctx.raft[method]()
        const { returnValue: role } = ctx.Leader.firstCall
        assert(role.destroy.calledOnce)
      })
    })
  }

  const emitsEvent = (method, event) => {
    it(`emits a ${event} event`, ctx => {
      const currentTerm = Symbol()
      ctx.raft.state._currentTerm.returns(currentTerm)

      ctx.raft[method]()
      assert(ctx.emitEvent.calledOnce)
      const { args: [emitted, term] } = ctx.emitEvent.firstCall
      assert(emitted === event)
      assert(term === currentTerm)
    })

    context(`the role is changed before the ${event} event is emitted`, () => {
      it('does not emit the event', ctx => {
        Object.defineProperty(ctx.raft, 'currentRole', {
          get () { return this._role || null },
          set (role) {
            this._role = role
            if (role) {
              role.start = () => {
                ctx.raft.currentRole = null
              }
            }
          }
        })

        ctx.raft[method]()
        assert(ctx.emitEvent.notCalled)
      })
    })
  }

  const startsRole = (method, role) => {
    it(`starts the ${role}`, ctx => {
      ctx.raft[method]()
      assert(ctx.raft.currentRole.start.calledOnce)
    })
  }

  describe('constructor ({ id, electionTimeoutWindow, heartbeatInterval, persistState, persistEntries, applyEntry, crashHandler, emitEvent })', () => {
    it('instantiates the state', ctx => {
      assert(ctx.State.calledOnce)
      const { args: [persistState], returnValue: state } = ctx.State.firstCall
      assert(persistState === ctx.persistState)
      assert(state === ctx.raft.state)
    })

    it('instantiates the log entry applier', ctx => {
      assert(ctx.LogEntryApplier.calledOnce)
      const { args: [{ applyEntry, crashHandler }] } = ctx.LogEntryApplier.firstCall
      assert(applyEntry === ctx.applyEntry)
      assert(crashHandler === ctx.crashHandler)
    })

    it('instantiates the log', ctx => {
      assert(ctx.Log.calledOnce)
      const { args: [{ persistEntries, applier }], returnValue: log } = ctx.Log.firstCall
      assert(persistEntries === ctx.persistEntries)
      assert(applier === ctx.LogEntryApplier.firstCall.returnValue)
      assert(log === ctx.raft.log)
    })
  })

  describe('#replaceState (state)', () => {
    it('replaces the state', ctx => {
      const state = Symbol()
      ctx.raft.replaceState(state)
      assert(ctx.raft.state.replace.calledOnce)
      const { args: [replaced] } = ctx.raft.state.replace.firstCall
      assert(replaced === state)
    })
  })

  describe('#replaceLog (entries, lastApplied)', () => {
    it('replaces the log', ctx => {
      const [entries, lastApplied] = [Symbol(), Symbol()]
      ctx.raft.replaceLog(entries, lastApplied)
      assert(ctx.raft.log.replace.calledOnce)
      const { args: [replacedEntries, replacedApplied] } = ctx.raft.log.replace.firstCall
      assert(replacedEntries === entries)
      assert(replacedApplied === lastApplied)
    })
  })

  ;['close', 'destroy'].forEach(method => {
    describe(`#${method} ()`, () => {
      destroyCurrentRole(method)

      it(`calls ${method}() on the log and returns the result`, ctx => {
        const result = Symbol()
        ctx.raft.log[method].returns(result)
        assert(ctx.raft[method]() === result)
      })
    })
  })

  describe('#joinInitialCluster ({ addresses, connect, nonPeerStream })', () => {
    beforeEach(ctx => {
      ctx.addresses = [Symbol(), Symbol()]
      ctx.streams = new Map().set(ctx.addresses[0], Symbol()).set(ctx.addresses[1], Symbol())
      ctx.connect = spy(({ address }) => Promise.resolve(ctx.streams.get(address)))
      ctx.nonPeerStream = Symbol()
    })

    it('uses connect() to connect to each address', ctx => {
      const { addresses, connect, nonPeerStream } = ctx
      ctx.raft.joinInitialCluster({ addresses, connect, nonPeerStream })
      assert(ctx.connect.calledTwice)
      for (let n = 0; n < ctx.connect.callCount; n++) {
        const { args: [{ address, writeOnly }] } = ctx.connect.getCall(n)
        assert(address === ctx.addresses[n])
        assert(writeOnly !== true)
      }
    })

    context('connecting is successful', () => {
      it('instantiates a peer for each address and connected stream', async ctx => {
        const { addresses, connect, nonPeerStream } = ctx
        await ctx.raft.joinInitialCluster({ addresses, connect, nonPeerStream })

        assert(ctx.Peer.calledTwice)
        assert(ctx.raft.peers.length === 2)

        const pending = new Set(addresses)
        for (let n = 0; n < ctx.Peer.callCount; n++) {
          const { args: [address, stream], returnValue: peer } = ctx.Peer.getCall(n)
          assert(pending.delete(address))
          assert(stream === ctx.streams.get(address))
          assert(ctx.raft.peers[n] === peer)
        }
        assert(pending.size === 0)
      })

      it('instantiates a non-peer receiver for the nonPeerStream', async ctx => {
        const { addresses, connect, nonPeerStream } = ctx
        await ctx.raft.joinInitialCluster({ addresses, connect, nonPeerStream })

        assert(ctx.NonPeerReceiver.calledOnce)
        const { args: [stream, connectFn], returnValue: receiver } = ctx.NonPeerReceiver.firstCall
        assert(stream === nonPeerStream)
        assert(connectFn === connect)
        assert(ctx.raft.nonPeerReceiver === receiver)
      })

      it('converts to follower', async ctx => {
        const { addresses, connect, nonPeerStream } = ctx
        await ctx.raft.joinInitialCluster({ addresses, connect, nonPeerStream })

        assert(ctx.raft.convertToFollower.calledOnce)
      })

      describe('the returned promise', () => {
        it('is fulfilled', async ctx => {
          const { addresses, connect, nonPeerStream } = ctx
          assert(await ctx.raft.joinInitialCluster({ addresses, connect, nonPeerStream }) === undefined)
        })
      })
    })

    context('an address fails to connect', () => {
      beforeEach(ctx => ctx.connect = stub())

      context('another address is not yet connected', () => {
        context('that address connects', () => {
          it('does not instantiate a peer', async ctx => {
            ctx.connect.onCall(0).returns(Promise.reject())
            let connectOther
            ctx.connect.onCall(1).returns(new Promise(resolve => connectOther = resolve))

            const { addresses, connect, nonPeerStream } = ctx
            await getReason(ctx.raft.joinInitialCluster({ addresses, connect, nonPeerStream }))

            connectOther()
            await Promise.resolve()

            assert(ctx.Peer.notCalled)
          })
        })
      })

      describe('the returned promise', () => {
        it('is rejected with the failure reason', async ctx => {
          const err = Symbol()
          ctx.connect.returns(Promise.reject(err))

          const { addresses, connect, nonPeerStream } = ctx
          assert(await getReason(ctx.raft.joinInitialCluster({ addresses, connect, nonPeerStream })) === err)
        })
      })
    })
  })

  describe('#becomeLeader ()', () => {
    destroyCurrentRole('becomeLeader')
    emitsEvent('becomeLeader', 'leader')

    it('instantiates the leader role', ctx => {
      ctx.raft.peers = Symbol()
      ctx.raft.nonPeerReceiver = Symbol()
      ctx.raft.becomeLeader()

      assert(ctx.Leader.calledOnce)
      assert(ctx.raft.currentRole === ctx.Leader.firstCall.returnValue)

      const { args: [{ heartbeatInterval, state, log, peers, nonPeerReceiver, crashHandler, convertToCandidate, convertToFollower }] } = ctx.Leader.firstCall
      assert(heartbeatInterval === ctx.heartbeatInterval)
      assert(state === ctx.raft.state)
      assert(log === ctx.raft.log)
      assert(peers === ctx.raft.peers)
      assert(nonPeerReceiver === ctx.raft.nonPeerReceiver)
      assert(crashHandler === ctx.raft.crashHandler)

      convertToCandidate()
      assert(ctx.raft.convertToCandidate.calledOnce)
      assert(ctx.raft.convertToCandidate.calledOn(ctx.raft))

      const replayMessage = Symbol()
      convertToFollower(replayMessage)
      assert(ctx.raft.convertToFollower.calledOnce)
      assert(ctx.raft.convertToFollower.calledOn(ctx.raft))
      const { args: [messageToReplay] } = ctx.raft.convertToFollower.firstCall
      assert(messageToReplay === replayMessage)
    })

    startsRole('becomeLeader', 'leader')
  })

  describe('#convertToCandidate ()', () => {
    destroyCurrentRole('convertToCandidate')
    emitsEvent('convertToCandidate', 'candidate')

    it('instantiates the candidate role', ctx => {
      ctx.raft.peers = Symbol()
      ctx.raft.nonPeerReceiver = Symbol()
      ctx.raft.convertToCandidate()

      assert(ctx.Candidate.calledOnce)
      assert(ctx.raft.currentRole === ctx.Candidate.firstCall.returnValue)

      const { args: [{ ourId, electionTimeout, state, log, peers, nonPeerReceiver, crashHandler, convertToFollower, becomeLeader }] } = ctx.Candidate.firstCall
      assert(ourId === ctx.id)
      assert(electionTimeout >= ctx.electionTimeoutWindow[0] && electionTimeout < ctx.electionTimeoutWindow[1])
      assert(state === ctx.raft.state)
      assert(log === ctx.raft.log)
      assert(peers === ctx.raft.peers)
      assert(nonPeerReceiver === ctx.raft.nonPeerReceiver)
      assert(crashHandler === ctx.raft.crashHandler)

      becomeLeader()
      assert(ctx.raft.becomeLeader.calledOnce)
      assert(ctx.raft.becomeLeader.calledOn(ctx.raft))

      const replayMessage = Symbol()
      convertToFollower(replayMessage)
      assert(ctx.raft.convertToFollower.calledOnce)
      assert(ctx.raft.convertToFollower.calledOn(ctx.raft))
      const { args: [messageToReplay] } = ctx.raft.convertToFollower.firstCall
      assert(messageToReplay === replayMessage)
    })

    startsRole('convertToCandidate', 'candidate')
  })

  describe('#convertToFollower (replayMessage)', () => {
    destroyCurrentRole('convertToFollower')
    emitsEvent('convertToFollower', 'follower')

    it('instantiates the follower role', ctx => {
      ctx.raft.peers = Symbol()
      ctx.raft.nonPeerReceiver = Symbol()
      ctx.raft.convertToFollower()

      assert(ctx.Follower.calledOnce)
      assert(ctx.raft.currentRole === ctx.Follower.firstCall.returnValue)

      const { args: [{ electionTimeout, state, log, peers, nonPeerReceiver, crashHandler, convertToCandidate }] } = ctx.Follower.firstCall
      assert(electionTimeout >= ctx.electionTimeoutWindow[0] && electionTimeout < ctx.electionTimeoutWindow[1])
      assert(state === ctx.raft.state)
      assert(log === ctx.raft.log)
      assert(peers === ctx.raft.peers)
      assert(nonPeerReceiver === ctx.raft.nonPeerReceiver)
      assert(crashHandler === ctx.raft.crashHandler)

      convertToCandidate()
      assert(ctx.raft.convertToCandidate.calledOnce)
      assert(ctx.raft.convertToCandidate.calledOn(ctx.raft))
    })

    startsRole('convertToFollower', 'follower')

    it('passes on the replayMessage', ctx => {
      const replayMessage = Symbol()
      ctx.raft.convertToFollower(replayMessage)
      assert(ctx.raft.currentRole.start.calledOnce)
      const { args: [messageToReplay] } = ctx.raft.currentRole.start.firstCall
      assert(messageToReplay === replayMessage)
    })
  })

  describe('#append (value)', () => {
    context('there is no current role', () => {
      it('returns a rejected promise', async ctx => {
        assert(await getReason(ctx.raft.append()) instanceof Error)
      })
    })

    context('the current role does not have an append() method', () => {
      it('returns a rejected promise', async ctx => {
        ctx.raft.convertToFollower()
        assert(await getReason(ctx.raft.append()) instanceof Error)
      })
    })

    context('the current role has an append() method', () => {
      it('calls it with the value and returns the result', ctx => {
        ctx.raft.becomeLeader()
        const result = Symbol()
        ctx.raft.currentRole.append.returns(result)

        const value = Symbol()
        assert(ctx.raft.append(value) === result)
        const { args: [appended] } = ctx.raft.currentRole.append.firstCall
        assert(appended === value)
      })
    })
  })
})
