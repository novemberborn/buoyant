import { afterEach, beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import { stub } from 'sinon'

import { stubMessages, stubPeer } from '../support/stub-helpers'

import InputConsumer from '🏠/lib/InputConsumer'

describe('InputConsumer', () => {
  // Sets up the first call of the scheduler.asap() stub so it returns a promise
  // that is resolved with the result of the callback passed to asap(). This
  // improves the tests ability to mock the scheduler.
  const asapRunner = ctx => {
    let run
    ctx.scheduler.asap.onCall(0).returns(new Promise(resolve => {
      run = () => {
        const { args: [, fn] } = ctx.scheduler.asap.firstCall
        resolve(fn())
        return new Promise(resolve => setImmediate(resolve))
      }
    }))
    return run
  }

  const assertCrashed = (ctx, err) => {
    assert(ctx.handlers.crash.calledOnce)
    const { args: [reason] } = ctx.handlers.crash.firstCall
    assert(reason === err)
  }

  beforeEach(ctx => {
    const scheduler = ctx.scheduler = stub({ asap () {} })
    ctx.scheduler.asap.returns(new Promise(() => {}))

    const peers = ctx.peers = [ctx.peer = stubPeer(), stubPeer(), stubPeer()]

    const nonPeerReceiver = ctx.nonPeerReceiver = stub({
      messages: stubMessages(),
      createPeer () {}
    })
    ctx.nonPeerReceiver.createPeer.returns(new Promise(() => {}))

    ctx.handlers = {
      message: stub().returns(new Promise(() => {})),
      crash: stub()
    }

    ctx.consumer = new InputConsumer({
      peers,
      nonPeerReceiver,
      scheduler,
      handleMessage (...args) { return ctx.handlers.message(...args) },
      crashHandler (...args) { return ctx.handlers.crash(...args) }
    })
  })

  afterEach(ctx => ctx.consumer.stop())

  describe('#start ()', () => {
    it('starts consuming messages', ctx => {
      assert(ctx.peer.messages.canTake.notCalled)
      ctx.consumer.start()
      assert(ctx.peer.messages.canTake.calledOnce)
    })
  })

  describe('message consumption', () => {
    it('consults each peer in order', ctx => {
      ctx.consumer.start()
      const canTakes = ctx.peers.map(peer => peer.messages.canTake)
      assert(canTakes[0].calledBefore(canTakes[1]))
      assert(canTakes[1].calledBefore(canTakes[2]))
    })

    context('a message can be taken', () => {
      beforeEach(ctx => ctx.peers[1].messages.canTake.onCall(0).returns(true))

      it('schedules handling the message', ctx => {
        ctx.consumer.start()
        assert(ctx.scheduler.asap.calledOnce)
        const { args: [handleAbort, fn] } = ctx.scheduler.asap.firstCall
        assert(handleAbort === null)
        assert(typeof fn === 'function')
      })

      it('only takes the message when it can be handled', ctx => {
        ctx.consumer.start()
        assert(ctx.peers[1].messages.take.notCalled)

        ctx.scheduler.asap.yield()
        assert(ctx.peers[1].messages.take.calledOnce)
      })

      it('passes the peer and the message to handleMessage()', ctx => {
        const message = Symbol()
        ctx.peers[1].messages.take.returns(message)
        ctx.scheduler.asap.onCall(0).yields()

        ctx.consumer.start()
        assert(ctx.handlers.message.calledOnce)
        const { args: [fromPeer, received] } = ctx.handlers.message.firstCall
        assert(fromPeer === ctx.peers[1])
        assert(received === message)
      })

      context('the scheduler returns a promise', () => {
        it('does not consult the next peer', ctx => {
          ctx.scheduler.asap.returns(new Promise(() => {}))
          ctx.consumer.start()
          assert(ctx.peers[2].messages.canTake.notCalled)
        })

        context('the promise is fulfilled', () => {
          it('consults the next peer', async ctx => {
            let fulfil
            ctx.scheduler.asap.onCall(0).returns(new Promise(resolve => fulfil = resolve))

            ctx.consumer.start()
            ctx.peers[0].messages.canTake.resetHistory()
            ctx.peers[1].messages.canTake.resetHistory()
            ctx.peers[2].messages.canTake.returns(true)

            fulfil()
            await Promise.resolve()

            assert(ctx.peers[0].messages.canTake.notCalled)
            assert(ctx.peers[1].messages.canTake.notCalled)
            assert(ctx.peers[2].messages.canTake.calledOnce)
          })
        })

        context('the promise is rejected', () => {
          it('crashes the consumer', async ctx => {
            const err = Symbol()
            ctx.scheduler.asap.onCall(0).returns(Promise.reject(err))
            ctx.consumer.start()

            await new Promise(resolve => setImmediate(resolve))
            assertCrashed(ctx, err)
          })
        })
      })

      context('the scheduler does not return anything', () => {
        beforeEach(ctx => ctx.scheduler.asap.returns())

        it('keeps consulting peers until no message can be taken', ctx => {
          ctx.peer.messages.canTake.onCall(1).returns(true)
          ctx.consumer.start()

          const calls = [0, 1].reduce((calls, n) => {
            return calls.concat(ctx.peers.map(peer => peer.messages.canTake.getCall(n)))
          }, []).filter(call => call)

          assert(calls.length === 6)
          assert(calls[0].calledBefore(calls[1]))
          assert(calls[1].calledBefore(calls[2]))
          assert(calls[2].calledBefore(calls[3]))
          assert(calls[3].calledBefore(calls[4]))
          assert(calls[4].calledBefore(calls[5]))
        })

        context('handleMessage() fails', () => {
          it('crashes the consumer', async ctx => {
            const err = Symbol()
            ctx.handlers.message.throws(err)
            ctx.peer.messages.canTake.onCall(0).returns(true)
            ctx.peer.messages.take.returns(Symbol())
            ctx.scheduler.asap.yields()

            ctx.consumer.start()
            assertCrashed(ctx, err)
          })
        })
      })
    })

    context('no message can be taken', () => {
      it('consults the nonPeerReceiver', ctx => {
        ctx.consumer.start()
        assert(ctx.nonPeerReceiver.messages.canTake.calledOnce)
      })

      context('a non-peer message can be taken', () => {
        beforeEach(ctx => {
          ctx.nonPeerReceiver.messages.canTake.onCall(0).returns(true)
          ctx.nonPeerReceiver.messages.take.returns([])
        })

        it('schedules handling the message', ctx => {
          ctx.consumer.start()
          assert(ctx.scheduler.asap.calledOnce)
          const { args: [handleAbort, fn] } = ctx.scheduler.asap.firstCall
          assert(handleAbort === null)
          assert(typeof fn === 'function')
        })

        it('only takes the message when it can be handled', ctx => {
          ctx.consumer.start()
          assert(ctx.nonPeerReceiver.messages.take.notCalled)

          ctx.scheduler.asap.firstCall.yield()
          assert(ctx.nonPeerReceiver.messages.take.calledOnce)
        })

        it('creates a peer', ctx => {
          const address = Symbol()
          ctx.nonPeerReceiver.messages.take.returns([address])
          ctx.scheduler.asap.onCall(0).yields()
          ctx.consumer.start()

          assert(ctx.nonPeerReceiver.createPeer.calledOnce)
          const { args: [peerAddress] } = ctx.nonPeerReceiver.createPeer.firstCall
          assert(peerAddress === address)
        })

        context('creating the peer succeeds', () => {
          it('passes the peer and the message to handleMessage()', async ctx => {
            const message = Symbol()
            ctx.nonPeerReceiver.messages.take.returns([null, message])
            const peer = Symbol()
            ctx.nonPeerReceiver.createPeer.returns(Promise.resolve(peer))
            ctx.scheduler.asap.onCall(0).yields()
            ctx.consumer.start()

            await Promise.resolve()
            assert(ctx.handlers.message.calledOnce)
            const { args: [fromPeer, received] } = ctx.handlers.message.firstCall
            assert(fromPeer === peer)
            assert(received === message)
          })

          context('handleMessage() returns a promise', () => {
            context('the promise returned by the scheduler', () => {
              it('adopts the state of the handleMessage() promise', async ctx => {
                const state = Symbol()
                ctx.handlers.message.returns(Promise.resolve(state))
                ctx.nonPeerReceiver.createPeer.returns(Promise.resolve())
                ctx.consumer.start()

                const { args: [, fn] } = ctx.scheduler.asap.firstCall
                assert(await fn() === state)
              })
            })
          })

          context('handleMessage() fails', () => {
            it('crashes the consumer', async ctx => {
              const err = Symbol()
              ctx.handlers.message.throws(err)
              ctx.nonPeerReceiver.createPeer.returns(Promise.resolve())

              const runAsap = asapRunner(ctx)
              ctx.consumer.start()
              await runAsap()

              assertCrashed(ctx, err)
            })
          })
        })

        context('creating the peer fails', () => {
          it('crashes the consumer', async ctx => {
            const err = Symbol()
            ctx.nonPeerReceiver.createPeer.returns(Promise.reject(err))

            const runAsap = asapRunner(ctx)
            ctx.consumer.start()
            await runAsap()

            assertCrashed(ctx, err)
          })
        })
      })

      context('no message can be taken', () => {
        it('waits for a message to become available from any peer or the nonPeerReceiver', ctx => {
          ctx.consumer.start()

          for (const { messages } of ctx.peers) {
            assert(messages.await.calledOnce)
          }
          assert(ctx.nonPeerReceiver.messages.await.calledOnce)
        })

        context('a message becomes available', () => {
          it('consults the first peer (and so forth…)', async ctx => {
            let available
            ctx.peers[2].messages.await.onCall(0).returns(new Promise(resolve => available = resolve))
            ctx.consumer.start()

            // Reset first round of canTake() calls.
            const canTakes = ctx.peers.map(peer => peer.messages.canTake).concat(ctx.nonPeerReceiver.messages.canTake)
            for (const stub of canTakes) {
              stub.resetHistory()
            }
            assert(canTakes[0].notCalled)

            // Make a message available for the second peer.
            available()
            await new Promise(resolve => setImmediate(resolve))

            // Each canTake() should be invoked, in order (so first peer goes
            // first).
            assert(canTakes[0].calledBefore(canTakes[1]))
            assert(canTakes[1].calledBefore(canTakes[2]))
          })
        })

        context('an error occurs', () => {
          it('crashes the consumer', async ctx => {
            const err = Symbol()
            ctx.peers[2].messages.await.onCall(0).returns(Promise.reject(err))

            ctx.consumer.start()
            await new Promise(resolve => setImmediate(resolve))

            assertCrashed(ctx, err)
          })
        })
      })
    })
  })

  describe('#stop ()', () => {
    beforeEach(ctx => ctx.canTakes = ctx.peers.map(peer => peer.messages.canTake).concat(ctx.nonPeerReceiver.messages.canTake))

    const noTakes = (ctx, canTakes = ctx.canTakes) => {
      for (const canTake of canTakes) {
        assert(canTake.notCalled)
      }
    }
    const resetTakes = ctx => {
      for (const canTake of ctx.canTakes) {
        canTake.resetHistory()
      }
      assert(ctx.canTakes[0].notCalled)
    }

    // handleMessage() could stop the consumer directly, or while it's doing
    // something asynchronous, something else could stop the consumer. Both
    // scenarios are indistinguishable as far as the test goes.
    context('while waiting for the scheduler-returned promise', () => {
      it('prevents consuming any messages once the promise fulfills', async ctx => {
        let fulfil
        ctx.scheduler.asap.onCall(0).returns(new Promise(resolve => fulfil = resolve))
        ctx.canTakes[0].returns(true)

        ctx.consumer.start()
        resetTakes(ctx)
        ctx.consumer.stop()

        fulfil()
        await new Promise(resolve => setImmediate(resolve))

        noTakes(ctx)
      })
    })

    context('while waiting for messages to become available', () => {
      it('prevents consuming any messages once a message becomes available', async ctx => {
        let available
        ctx.peers[2].messages.await.onCall(0).returns(new Promise(resolve => available = resolve))

        ctx.consumer.start()
        resetTakes(ctx)
        ctx.consumer.stop()

        available()
        await new Promise(resolve => setImmediate(resolve))

        noTakes(ctx)
      })
    })

    // The only interesting scenario is if handleMessage() behaves
    // synchronously, all other scenarios result in the scheduler returning a
    // promise, which is already being tested.
    context('as a side-effect of a handleMessage() call', () => {
      context('for a message from a peer', () => {
        context('without the scheduler returning a promise', () => {
          it('stops consuming of any messages from further peers', ctx => {
            ctx.canTakes[0].returns(true)
            ctx.scheduler.asap.onCall(0).yields().returns(undefined)
            ctx.handlers.message = () => ctx.consumer.stop()

            ctx.consumer.start()

            assert(ctx.canTakes[0].calledOnce)
            noTakes(ctx, ctx.canTakes.slice(1))
          })
        })
      })
    })

    context('while creating the peer when handling a non-peer message', () => {
      it('does not invoke handleMessage()', async ctx => {
        ctx.scheduler.asap.onCall(0).yields()
        ctx.nonPeerReceiver.messages.canTake.returns(true)
        ctx.nonPeerReceiver.messages.take.returns([])
        let create
        ctx.nonPeerReceiver.createPeer.returns(new Promise(resolve => create = resolve))

        ctx.consumer.start()
        assert(ctx.nonPeerReceiver.createPeer.calledOnce)
        ctx.consumer.stop()

        create()
        await Promise.resolve()

        assert(ctx.handlers.message.notCalled)
      })
    })
  })
})
