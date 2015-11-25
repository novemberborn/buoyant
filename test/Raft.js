import { before, beforeEach, describe, context, it } from '!mocha'
import assert from 'power-assert'
import proxyquire from 'proxyquire'
import sinon from 'sinon'

import { getReason } from './support/utils'

describe('Raft', () => {
  before(ctx => {
    ctx.Candidate = sinon.spy(() => sinon.stub({ destroy () {}, start () {} }))
    ctx.Follower = sinon.spy(() => sinon.stub({ destroy () {}, start () {} }))
    ctx.Leader = sinon.spy(() => sinon.stub({ destroy () {}, start () {}, append () {} }))

    ctx.Log = sinon.spy(() => sinon.stub({ replace () {}, close () {}, destroy () {} }))
    ctx.LogEntryApplier = sinon.spy(() => sinon.stub())
    ctx.State = sinon.spy(() => sinon.stub({ replace () {} }))

    ctx.NonPeerReceiver = sinon.spy(() => sinon.stub())
    ctx.Peer = sinon.spy(() => sinon.stub())

    ctx.Raft = proxyquire.noCallThru()('../lib/Raft', {
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
    const emitEvent = ctx.emitEvent = sinon.spy()

    ctx.raft = new ctx.Raft({ id, electionTimeoutWindow, heartbeatInterval, persistState, persistEntries, applyEntry, crashHandler, emitEvent })
    sinon.spy(ctx.raft, 'becomeLeader')
    sinon.spy(ctx.raft, 'convertToCandidate')
    sinon.spy(ctx.raft, 'convertToFollower')
  })

  const destroyCurrentRole = method => {
    context('there is a current role', () => {
      it('destroys the role', ctx => {
        ctx.raft.becomeLeader()
        ctx.raft[method]()
        sinon.assert.calledOnce(ctx.Leader.getCall(0).returnValue.destroy)
      })
    })
  }

  const emitsEvent = (method, event) => {
    it(`emits a ${event} event`, ctx => {
      ctx.raft[method]()
      sinon.assert.calledOnce(ctx.emitEvent)
      sinon.assert.calledWithExactly(ctx.emitEvent, event)
    })
  }

  const startsRole = (method, role) => {
    it(`starts the ${role}`, ctx => {
      ctx.raft[method]()
      sinon.assert.calledOnce(ctx.raft.currentRole.start)
    })
  }

  describe('constructor ({ id, electionTimeoutWindow, heartbeatInterval, persistState, persistEntries, applyEntry, crashHandler, emitEvent })', () => {
    it('instantiates the state', ctx => {
      sinon.assert.calledOnce(ctx.State)
      sinon.assert.calledWithExactly(ctx.State, ctx.persistState)
      assert(ctx.raft.state === ctx.State.getCall(0).returnValue)
    })

    it('instantiates the log entry applier', ctx => {
      sinon.assert.calledOnce(ctx.LogEntryApplier)
      const { args: [{ applyEntry, crashHandler }] } = ctx.LogEntryApplier.getCall(0)
      assert(applyEntry === ctx.applyEntry)
      assert(crashHandler === ctx.crashHandler)
    })

    it('instantiates the log', ctx => {
      sinon.assert.calledOnce(ctx.Log)
      const { args: [{ persistEntries, applier }] } = ctx.Log.getCall(0)
      assert(persistEntries === ctx.persistEntries)
      assert(applier === ctx.LogEntryApplier.getCall(0).returnValue)
      assert(ctx.raft.log === ctx.Log.getCall(0).returnValue)
    })
  })

  describe('#replaceState (state)', () => {
    it('replaces the state', ctx => {
      const state = Symbol()
      ctx.raft.replaceState(state)
      sinon.assert.calledOnce(ctx.raft.state.replace)
      sinon.assert.calledWithExactly(ctx.raft.state.replace, state)
    })
  })

  describe('#replaceLog (entries, lastApplied)', () => {
    it('replaces the log', ctx => {
      const [entries, lastApplied] = [Symbol(), Symbol()]
      ctx.raft.replaceLog(entries, lastApplied)
      sinon.assert.calledOnce(ctx.raft.log.replace)
      sinon.assert.calledWithExactly(ctx.raft.log.replace, entries, lastApplied)
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
      ctx.connect = sinon.spy(({ address }) => Promise.resolve(ctx.streams.get(address)))
      ctx.nonPeerStream = Symbol()
    })

    it('uses connect() to connect to each address', ctx => {
      const { addresses, connect, nonPeerStream } = ctx
      ctx.raft.joinInitialCluster({ addresses, connect, nonPeerStream })
      sinon.assert.calledTwice(ctx.connect)
      {
        const { args: [{ address, readWrite }] } = ctx.connect.getCall(0)
        assert(address === ctx.addresses[0])
        assert(readWrite === true)
      }
      {
        const { args: [{ address, readWrite }] } = ctx.connect.getCall(1)
        assert(address === ctx.addresses[1])
        assert(readWrite === true)
      }
    })

    context('connecting is successful', () => {
      it('instantiates a peer for each address and connected stream', async ctx => {
        const { addresses, connect, nonPeerStream } = ctx
        await ctx.raft.joinInitialCluster({ addresses, connect, nonPeerStream })

        sinon.assert.calledTwice(ctx.Peer)
        for (const address of addresses) {
          sinon.assert.calledWithExactly(ctx.Peer, address, ctx.streams.get(address))
        }

        assert.deepStrictEqual(ctx.raft.peers, ctx.Peer.returnValues)
      })

      it('instantiates a non-peer receiver for the nonPeerStream', async ctx => {
        const { addresses, connect, nonPeerStream } = ctx
        await ctx.raft.joinInitialCluster({ addresses, connect, nonPeerStream })

        sinon.assert.calledOnce(ctx.NonPeerReceiver)
        sinon.assert.calledWithExactly(ctx.NonPeerReceiver, nonPeerStream, connect)
        assert(ctx.raft.nonPeerReceiver === ctx.NonPeerReceiver.getCall(0).returnValue)
      })

      it('converts to follower', async ctx => {
        const { addresses, connect, nonPeerStream } = ctx
        await ctx.raft.joinInitialCluster({ addresses, connect, nonPeerStream })

        sinon.assert.calledOnce(ctx.raft.convertToFollower)
      })

      describe('the returned promise', () => {
        it('is fulfilled', async ctx => {
          const { addresses, connect, nonPeerStream } = ctx
          assert(await ctx.raft.joinInitialCluster({ addresses, connect, nonPeerStream }) === undefined)
        })
      })
    })

    context('an address fails to connect', () => {
      beforeEach(ctx => ctx.connect = sinon.stub())

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

            sinon.assert.notCalled(ctx.Peer)
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

      sinon.assert.calledOnce(ctx.Leader)
      assert(ctx.raft.currentRole === ctx.Leader.getCall(0).returnValue)

      const { args: [{ heartbeatInterval, state, log, peers, nonPeerReceiver, crashHandler, convertToCandidate, convertToFollower }] } = ctx.Leader.getCall(0)
      assert(heartbeatInterval === ctx.heartbeatInterval)
      assert(state === ctx.raft.state)
      assert(log === ctx.raft.log)
      assert(peers === ctx.raft.peers)
      assert(nonPeerReceiver === ctx.raft.nonPeerReceiver)
      assert(crashHandler === ctx.raft.crashHandler)

      convertToCandidate()
      sinon.assert.calledOnce(ctx.raft.convertToCandidate)
      sinon.assert.calledOn(ctx.raft.convertToCandidate, ctx.raft)

      const replayMessage = Symbol()
      convertToFollower(replayMessage)
      sinon.assert.calledOnce(ctx.raft.convertToFollower)
      sinon.assert.calledOn(ctx.raft.convertToFollower, ctx.raft)
      sinon.assert.calledWithExactly(ctx.raft.convertToFollower, replayMessage)
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

      sinon.assert.calledOnce(ctx.Candidate)
      assert(ctx.raft.currentRole === ctx.Candidate.getCall(0).returnValue)

      const { args: [{ ourId, electionTimeout, state, log, peers, nonPeerReceiver, crashHandler, convertToFollower, becomeLeader }] } = ctx.Candidate.getCall(0)
      assert(ourId === ctx.id)
      assert(electionTimeout >= ctx.electionTimeoutWindow[0] && electionTimeout < ctx.electionTimeoutWindow[1])
      assert(state === ctx.raft.state)
      assert(log === ctx.raft.log)
      assert(peers === ctx.raft.peers)
      assert(nonPeerReceiver === ctx.raft.nonPeerReceiver)
      assert(crashHandler === ctx.raft.crashHandler)

      becomeLeader()
      sinon.assert.calledOnce(ctx.raft.becomeLeader)
      sinon.assert.calledOn(ctx.raft.becomeLeader, ctx.raft)

      const replayMessage = Symbol()
      convertToFollower(replayMessage)
      sinon.assert.calledOnce(ctx.raft.convertToFollower)
      sinon.assert.calledOn(ctx.raft.convertToFollower, ctx.raft)
      sinon.assert.calledWithExactly(ctx.raft.convertToFollower, replayMessage)
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

      sinon.assert.calledOnce(ctx.Follower)
      assert(ctx.raft.currentRole === ctx.Follower.getCall(0).returnValue)

      const { args: [{ electionTimeout, state, log, peers, nonPeerReceiver, crashHandler, convertToCandidate }] } = ctx.Follower.getCall(0)
      assert(electionTimeout >= ctx.electionTimeoutWindow[0] && electionTimeout < ctx.electionTimeoutWindow[1])
      assert(state === ctx.raft.state)
      assert(log === ctx.raft.log)
      assert(peers === ctx.raft.peers)
      assert(nonPeerReceiver === ctx.raft.nonPeerReceiver)
      assert(crashHandler === ctx.raft.crashHandler)

      convertToCandidate()
      sinon.assert.calledOnce(ctx.raft.convertToCandidate)
      sinon.assert.calledOn(ctx.raft.convertToCandidate, ctx.raft)
    })

    startsRole('convertToFollower', 'follower')

    it('passes on the replayMessage', ctx => {
      const replayMessage = Symbol()
      ctx.raft.convertToFollower(replayMessage)
      sinon.assert.calledOnce(ctx.raft.currentRole.start)
      sinon.assert.calledWithExactly(ctx.raft.currentRole.start, replayMessage)
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
        sinon.assert.calledWithExactly(ctx.raft.currentRole.append, value)
      })
    })
  })
})
