import { before, beforeEach, describe, context, it } from '!mocha'
import assert from 'power-assert'
import proxyquire from 'proxyquire'
import { spy, stub } from 'sinon'

import { getReason } from './support/utils'

import exposeEvents from '../lib/expose-events'
import Address from '../lib/Address'

function schedulePromiseCallback (cb) {
  Promise.resolve().then(cb).catch(() => undefined)
}

describe('Server', () => {
  before(ctx => {
    ctx.exposeEvents = spy((...args) => exposeEvents(...args))
    ctx.Raft = spy(() => stub({
      replaceState () {},
      replaceLog () {},
      close () {},
      destroy () {},
      joinInitialCluster () {},
      append () {}
    }))

    ctx.createTransport = spy(() => stub({
      listen () {},
      connect () {},
      destroy () {}
    }))

    ctx.Server = proxyquire.noCallThru()('../lib/Server', {
      './expose-events': function (...args) { return ctx.exposeEvents(...args) },
      './Raft': function (...args) { return ctx.Raft(...args) }
    })['default']
  })

  beforeEach(ctx => {
    ctx.exposeEvents.reset()
    ctx.Raft.reset()
    ctx.createTransport.reset()

    const id = ctx.id = Symbol()
    const address = ctx.address = Symbol()
    const electionTimeoutWindow = ctx.electionTimeoutWindow = Symbol()
    const heartbeatInterval = ctx.heartbeatInterval = Symbol()
    const persistState = ctx.persistState = Symbol()
    const persistEntries = ctx.persistEntries = Symbol()
    const applyEntry = ctx.applyEntry = Symbol()
    const crashHandler = ctx.crashHandler = Symbol()

    // Proxy ctx.createTransport() via a wrapper object, allowing tests to
    // change the implementation even after the server instance was created.
    ctx.createTransportProxy = { createTransport: ctx.createTransport }
    const createTransport = (...args) => ctx.createTransportProxy.createTransport(...args)

    ctx.server = new ctx.Server({ id, address, electionTimeoutWindow, heartbeatInterval, createTransport, persistState, persistEntries, applyEntry, crashHandler })
    ctx.raft = ctx.server._raft
  })

  describe('constructor ({ id, address, electionTimeoutWindow, heartbeatInterval, createTransport, persistState, persistEntries, applyEntry, crashHandler })', () => {
    it('instantiates the raft implementation', ctx => {
      assert(ctx.Raft.calledOnce)
      assert(ctx.raft === ctx.Raft.firstCall.returnValue)

      const { args: [{ id, electionTimeoutWindow, heartbeatInterval, persistState, persistEntries, applyEntry, crashHandler, emitEvent }] } = ctx.Raft.firstCall
      assert(id === ctx.id)
      assert(electionTimeoutWindow === ctx.electionTimeoutWindow)
      assert(heartbeatInterval === ctx.heartbeatInterval)
      assert(persistState === ctx.persistState)
      assert(persistEntries === ctx.persistEntries)
      assert(applyEntry === ctx.applyEntry)
      assert(crashHandler === ctx.crashHandler)
      assert(typeof emitEvent === 'function')
    })

    context('the raft implementation emits an event', () => {
      it('is emitted on the server', async ctx => {
        const listener = spy()
        const event = Symbol()
        ctx.server.on(event, listener)

        const { args: [{ emitEvent }] } = ctx.Raft.firstCall

        const args = [Symbol(), Symbol()]
        emitEvent(event, ...args)

        await Promise.resolve()
        assert(listener.calledOnce)
        const { args: receivedArgs } = listener.firstCall
        assert.deepStrictEqual(receivedArgs, args)
      })
    })

    it('exposes events', ctx => {
      assert(ctx.exposeEvents.calledOnce)
      const { args: [context] } = ctx.exposeEvents.firstCall
      assert(context === ctx.server)
    })

    ;['id', 'address'].forEach(prop => {
      it(`sets ${prop} on the instance`, ctx => {
        const { value, writable, configurable, enumerable } = Object.getOwnPropertyDescriptor(ctx.server, prop)
        assert(value === ctx[prop])
        assert(writable === false)
        assert(configurable === false)
        assert(enumerable === true)
      })
    })
  })

  describe('#restoreState (state)', () => {
    context('the server has joined a cluster', () => {
      it('throws', ctx => {
        ctx.server.join()
        assert.throws(() => ctx.server.restoreState(), Error, 'Restoring state is no longer allowed')
      })
    })

    context('the server has not joined a cluster', () => {
      it('calls replaceState() on the raft implementation', ctx => {
        const state = Symbol()
        ctx.server.restoreState(state)
        assert(ctx.raft.replaceState.calledOnce)
        const { args: [replaced] } = ctx.raft.replaceState.firstCall
        assert(replaced === state)
      })
    })
  })

  describe('#restoreLog (entries, lastApplied)', () => {
    context('the server has joined a cluster', () => {
      it('throws', ctx => {
        ctx.server.join()
        assert.throws(() => ctx.server.restoreLog(), Error, 'Restoring log is no longer allowed')
      })
    })

    context('the server has not joined a cluster', () => {
      it('calls restoreLog() on the raft implementation', ctx => {
        const [entries, lastApplied] = [Symbol(), Symbol()]
        ctx.server.restoreLog(entries, lastApplied)
        assert(ctx.raft.replaceLog.calledOnce)
        const { args: [replacedEntries, replacedApplied] } = ctx.raft.replaceLog.firstCall
        assert(replacedEntries === entries)
        assert(replacedApplied === lastApplied)
      })
    })
  })

  const closeOrDestroy = (which, pastTense) => {
    it(`calls ${which}() on the raft implementation`, ctx => {
      ctx.server[which]()
      assert(ctx.raft[which].calledOnce)
    })

    context('the server has joined a cluster', () => {
      it('destroys the transport', ctx => {
        ctx.server.join()
        const { returnValue: transport } = ctx.createTransport.firstCall

        ctx.server[which]()
        assert(transport.destroy.calledOnce)
      })
    })

    context(`the raft implementation was ${pastTense} successfully`, () => {
      beforeEach(ctx => ctx.raft[which].returns(Promise.resolve()))

      context('there was a transport to destroy', () => {
        beforeEach(ctx => {
          ctx.server.join()
          const { returnValue: transport } = ctx.createTransport.firstCall
          ctx.transport = transport
        })

        context('it returned a fulfilled promise', () => {
          it('fulfills the returned promise', async ctx => {
            ctx.transport.destroy.returns(Promise.resolve())
            assert(await ctx.server[which]() === undefined)
          })
        })

        context('it did not return a promise', () => {
          it('fulfills the returned promise', async ctx => {
            ctx.transport.destroy.returns({})
            assert(await ctx.server[which]() === undefined)
          })
        })

        context('the transport failed to destroy', () => {
          context('it returned a rejected promise', () => {
            it('rejects the returned promise with the rejection reason', async ctx => {
              const err = Symbol()
              ctx.transport.destroy.returns(Promise.reject(err))
              assert(await getReason(ctx.server[which]()) === err)
            })
          })

          context('it threw an error', () => {
            it('rejects the returned promise with the error', async ctx => {
              const err = Symbol()
              ctx.transport.destroy.throws(err)
              assert(await getReason(ctx.server[which]()) === err)
            })
          })
        })
      })

      context('there was no transport to destroy', () => {
        it('fulfills the returned promise', async ctx => {
          assert(await ctx.server[which]() === undefined)
        })
      })
    })

    context(`the raft implementation failed to ${which}`, () => {
      it('rejects the returned promise with the failure reason', async ctx => {
        const err = Symbol()
        ctx.raft[which].returns(Promise.reject(err))
        assert(await getReason(ctx.server[which]()) === err)
      })
    })
  }

  describe('#close ()', () => {
    closeOrDestroy('close', 'closed')

    context('called multiple times', () => {
      it('returns the same promise', ctx => {
        const p1 = ctx.server.close()
        const p2 = ctx.server.close()
        assert(p1 === p2)
      })

      context('there was a transport to destroy', () => {
        it('is only destroyed once', ctx => {
          ctx.server.join()
          const { returnValue: transport } = ctx.createTransport.firstCall
          ctx.transport = transport

          ctx.server.close()
          assert(ctx.transport.destroy.calledOnce)

          ctx.server.close()
          assert(ctx.transport.destroy.calledOnce)
        })
      })
    })

    context('called after destroy()', () => {
      it('returns the same promise as was last returned by destroy()', ctx => {
        const p1 = ctx.server.destroy()
        const p2 = ctx.server.close()
        assert(p1 === p2)
      })
    })
  })

  describe('#destroy ()', () => {
    closeOrDestroy('destroy', 'destroyed')

    context('called multiple times', () => {
      it('returns a different promise each time', ctx => {
        const p1 = ctx.server.destroy()
        const p2 = ctx.server.destroy()
        assert(p1 !== p2)
      })

      context('there was a transport to destroy', () => {
        it('is only destroyed once', ctx => {
          ctx.server.join()
          const { returnValue: transport } = ctx.createTransport.firstCall
          ctx.transport = transport

          ctx.server.destroy()
          assert(ctx.transport.destroy.calledOnce)

          ctx.server.destroy()
          assert(ctx.transport.destroy.calledOnce)
        })
      })
    })

    context('called after close()', () => {
      it('returns a different promise', ctx => {
        const p1 = ctx.server.close()
        const p2 = ctx.server.destroy()
        assert(p1 !== p2)
      })
    })
  })

  describe('#join (addresses = [])', () => {
    it('creates Address instances if necessary', async ctx => {
      await ctx.server.join(['///first', '///second'])

      const { args: [{ addresses }] } = ctx.raft.joinInitialCluster.firstCall
      assert(addresses.length === 2)
      assert(addresses[0].serverId === 'first')
      assert(addresses[1].serverId === 'second')
    })

    context('an invalid address is encountered', () => {
      it('rejects the returned promise with the error', async ctx => {
        assert(await getReason(ctx.server.join(['invalid'])) instanceof TypeError)
      })
    })

    context('an Address instance was provided', () => {
      it('is used as-is', async ctx => {
        const address = new Address('///foo')
        await ctx.server.join([address])

        const { args: [{ addresses }] } = ctx.raft.joinInitialCluster.firstCall
        assert(addresses.length === 1)
        assert(addresses[0] === address)
      })
    })

    context('no addresses argument was provided', () => {
      it('joins an empty cluster', async ctx => {
        await ctx.server.join()

        const { args: [{ addresses }] } = ctx.raft.joinInitialCluster.firstCall
        assert(addresses.length === 0)
      })
    })

    context('the server already joined a cluster', () => {
      it('rejects the returned promise', async ctx => {
        ctx.server.join()
        const reason = await getReason(ctx.server.join())
        assert(reason instanceof Error)
        assert(reason.message === 'Joining a cluster is no longer allowed')
      })
    })

    context('the server was closed', () => {
      it('rejects the returned promise', async ctx => {
        ctx.server.close()
        const reason = await getReason(ctx.server.join())
        assert(reason instanceof Error)
        assert(reason.message === 'Server is closed')
      })
    })

    context('the server was destroyed', () => {
      it('rejects the returned promise', async ctx => {
        ctx.server.destroy()
        const reason = await getReason(ctx.server.join())
        assert(reason instanceof Error)
        assert(reason.message === 'Server is closed')
      })
    })

    it('creates the transport', ctx => {
      ctx.server.join()
      assert(ctx.createTransport.calledOnce)
      const { args: [address] } = ctx.createTransport.firstCall
      assert(address === ctx.address)
    })

    it('calls listen() on the transport', ctx => {
      ctx.server.join()
      const { returnValue: transport } = ctx.createTransport.firstCall
      assert(transport.listen.calledOnce)
    })

    const testJoinFailureHandling = (type, getError) => {
      context('the server was not closed or destroyed', () => {
        it('destroys the transport', async ctx => {
          await getReason(ctx.server.join())

          assert(ctx.transport.destroy.calledOnce)
        })

        it(`rejects the returned promise with the ${type} failure`, async ctx => {
          assert(await getReason(ctx.server.join()) === getError(ctx))
        })

        context('destroying the transport fails', () => {
          context('it returned a rejected promise', () => {
            it(`rejects the returned promise with the ${type} failure`, async ctx => {
              ctx.transport.destroy.returns(Promise.reject(Symbol()))
              assert(await getReason(ctx.server.join()) === getError(ctx))
            })
          })

          context('it threw an error', () => {
            it(`rejects the returned promise with the ${type} failure`, async ctx => {
              ctx.transport.destroy.throws(Symbol())
              assert(await getReason(ctx.server.join()) === getError(ctx))
            })
          })
        })
      })

      context('the server was closed', () => {
        it(`rejects the returned promise with the ${type} failure`, async ctx => {
          // The handling of the listening failure is asynchronous, meaning
          // the server can be closed between the error occurring and it
          // being handled. Set that up here.
          schedulePromiseCallback(() => ctx.server.close())
          assert(await getReason(ctx.server.join()) === getError(ctx))
        })
      })

      context('the server was destroyed', () => {
        it(`rejects the returned promise with the ${type} failure`, async ctx => {
          // The handling of the listening failure is asynchronous, meaning
          // the server can be closed between the error occurring and it
          // being handled. Set that up here.
          schedulePromiseCallback(() => ctx.server.destroy())
          assert(await getReason(ctx.server.join()) === getError(ctx))
        })
      })
    }

    context('listening fails', () => {
      ;[
        { desc: 'listen() threw an error', setup (listen, err) { listen.throws(err) } },
        { desc: 'listen() returned a rejected promise', setup (listen, err) { listen.returns(Promise.reject(err)) } }
      ].forEach(({ desc, setup }) => {
        context(desc, () => {
          beforeEach(ctx => {
            // Get a valid transport stub, then change createTransport() to
            // always return that stub.
            ctx.transport = ctx.createTransport()
            ctx.createTransportProxy.createTransport = stub().returns(ctx.transport)

            ctx.listeningFailure = Symbol()
            setup(ctx.transport.listen, ctx.listeningFailure)
          })

          testJoinFailureHandling('listening', ctx => ctx.listeningFailure)
        })
      })
    })

    context('listening succeeds', () => {
      ;[
        { desc: 'listen() returned a promise fulfilled with the nonPeerStream', setup (listen, nonPeerStream) { listen.returns(Promise.resolve(nonPeerStream)) } },
        { desc: 'listen() returned the nonPeerStream directly', setup (listen, nonPeerStream) { listen.returns(nonPeerStream) } }
      ].forEach(({ desc, setup }) => {
        context(desc, () => {
          beforeEach(ctx => {
            // Get a valid transport stub, then change createTransport() to
            // always return that stub.
            ctx.transport = ctx.createTransport()
            ctx.createTransportProxy.createTransport = stub().returns(ctx.transport)

            ctx.nonPeerStream = Symbol()
            setup(ctx.transport.listen, ctx.nonPeerStream)
          })

          it('joins the cluster', async ctx => {
            await ctx.server.join()

            assert(ctx.raft.joinInitialCluster.calledOnce)
            const { args: [{ addresses, connect, nonPeerStream }] } = ctx.raft.joinInitialCluster.firstCall
            assert(Array.isArray(addresses))
            assert(typeof connect === 'function')
            assert(nonPeerStream === ctx.nonPeerStream)
          })

          context('joining succeeds', () => {
            it('fulfills the promise returned by join()', async ctx => {
              assert(await ctx.server.join() === undefined)
            })
          })

          context('joining fails', () => {
            beforeEach(ctx => {
              ctx.joiningFailure = Symbol()
              ctx.raft.joinInitialCluster.returns(Promise.reject(ctx.joiningFailure))
            })

            testJoinFailureHandling('joining', ctx => ctx.joiningFailure)
          })
        })
      })

      describe('the connect() method passed to Raft#joinInitialCluster()', () => {
        beforeEach(async ctx => {
          // Get a valid transport stub, then change createTransport() to
          // always return that stub.
          ctx.transport = ctx.createTransport()
          ctx.createTransportProxy.createTransport = stub().returns(ctx.transport)

          await ctx.server.join()
          const { args: [{ connect }] } = ctx.raft.joinInitialCluster.firstCall
          ctx.connect = connect
        })

        it('calls the transport’s connect() with the given options', ctx => {
          const opts = Symbol()
          ctx.connect(opts)
          assert(ctx.transport.connect.calledOnce)
          const { args: [receivedOpts] } = ctx.transport.connect.firstCall
          assert(receivedOpts === opts)
        })

        context('the transport’s connect() returns a promise', () => {
          context('the promise is fulfilled', () => {
            it('fulfills the promise returned by the connect() method passed to Raft#joinInitialCluster()', async ctx => {
              const result = Symbol()
              ctx.transport.connect.returns(Promise.resolve(result))
              assert(await ctx.connect() === result)
            })
          })

          context('the promise is rejected', () => {
            it('rejects the promise returned by the connect() method passed to Raft#joinInitialCluster()', async ctx => {
              const err = Symbol()
              ctx.transport.connect.returns(Promise.reject(err))
              assert(await getReason(ctx.connect()) === err)
            })
          })
        })

        context('the transport’s connect() does not return a promise', () => {
          it('fulfills the promise returned by the connect() method passed to Raft#joinInitialCluster() with the returned value', async ctx => {
            const result = Symbol()
            ctx.transport.connect.returns(result)
            assert(await ctx.connect() === result)
          })
        })

        context('the transport’s connect() throws an error', () => {
          it('rejects the promise returned by the connect() method passed to Raft#joinInitialCluster() with the error', async ctx => {
            const err = Symbol()
            ctx.transport.connect.throws(err)
            assert(await getReason(ctx.connect()) === err)
          })
        })
      })
    })
  })

  describe('#append (value)', () => {
    it('calls append() on the raft implementation', ctx => {
      const result = Symbol()
      ctx.raft.append.returns(result)
      const value = Symbol()
      assert(ctx.server.append(value) === result)
      assert(ctx.raft.append.calledOnce)
      const { args: [appended] } = ctx.raft.append.firstCall
      assert(appended === value)
    })
  })
})
