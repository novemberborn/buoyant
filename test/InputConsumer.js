import { afterEach, beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import sinon from 'sinon'

import { stubMessages, stubPeer } from './support/stub-helpers'

import InputConsumer from '../lib/InputConsumer'

describe('InputConsumer', () => {
  // Sets up the first call of the scheduler.asap() stub so it returns a promise
  // that is resolved with the result of the callback passed to asap(). This
  // improves the tests ability to mock the scheduler.
  const asapRunner = ctx => {
    let run
    ctx.scheduler.asap.onCall(0).returns(new Promise(resolve => {
      run = () => {
        resolve(ctx.scheduler.asap.firstCall.args[1]())
        return new Promise(resolve => setImmediate(resolve))
      }
    }))
    return run
  }

  beforeEach(ctx => {
    const scheduler = ctx.scheduler = sinon.stub({ asap () {} })
    ctx.scheduler.asap.returns(new Promise(() => {}))

    const peers = ctx.peers = [ctx.peer = stubPeer(), stubPeer(), stubPeer()]

    const nonPeerReceiver = ctx.nonPeerReceiver = sinon.stub({
      messages: stubMessages(),
      createPeer () {}
    })
    ctx.nonPeerReceiver.createPeer.returns(new Promise(() => {}))

    ctx.handlers = {
      message: sinon.stub().returns(new Promise(() => {})),
      crash: sinon.stub()
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
      sinon.assert.notCalled(ctx.peer.messages.canTake)
      ctx.consumer.start()
      sinon.assert.calledOnce(ctx.peer.messages.canTake)
    })
  })

  describe('message consumption', () => {
    it('consults each peer in order', ctx => {
      ctx.consumer.start()
      const canTakes = ctx.peers.map(peer => peer.messages.canTake)
      sinon.assert.callOrder(...canTakes)
    })

    context('a message can be taken', () => {
      beforeEach(ctx => ctx.peers[1].messages.canTake.onCall(0).returns(true))

      it('schedules handling the message', ctx => {
        ctx.consumer.start()
        sinon.assert.calledOnce(ctx.scheduler.asap)
        sinon.assert.calledWithExactly(ctx.scheduler.asap, null, sinon.match.func)
      })

      it('only takes the message when it can be handled', ctx => {
        ctx.consumer.start()
        sinon.assert.notCalled(ctx.peers[1].messages.take)

        ctx.scheduler.asap.firstCall.args[1]()
        sinon.assert.calledOnce(ctx.peers[1].messages.take)
      })

      it('passes the peer and the message to handleMessage()', ctx => {
        const message = Symbol()
        ctx.peers[1].messages.take.returns(message)
        ctx.scheduler.asap.onCall(0).yields()

        ctx.consumer.start()
        sinon.assert.calledOnce(ctx.handlers.message)
        sinon.assert.calledWithExactly(ctx.handlers.message, ctx.peers[1], message)
      })

      context('the scheduler returns a promise', () => {
        it('does not consult the next peer', ctx => {
          ctx.scheduler.asap.returns(new Promise(() => {}))
          ctx.consumer.start()
          sinon.assert.notCalled(ctx.peers[2].messages.canTake)
        })

        context('the promise is fulfilled', () => {
          it('consults the next peer', async ctx => {
            let fulfil
            ctx.scheduler.asap.onCall(0).returns(new Promise(resolve => fulfil = resolve))

            ctx.consumer.start()
            ctx.peers[0].messages.canTake.reset()
            ctx.peers[1].messages.canTake.reset()
            ctx.peers[2].messages.canTake.returns(true)

            fulfil()
            await Promise.resolve()

            sinon.assert.notCalled(ctx.peers[0].messages.canTake)
            sinon.assert.notCalled(ctx.peers[1].messages.canTake)
            sinon.assert.calledOnce(ctx.peers[2].messages.canTake)
          })
        })

        context('the promise is rejected', () => {
          it('crashes the consumer', async ctx => {
            const err = Symbol()
            ctx.scheduler.asap.onCall(0).returns(Promise.reject(err))
            ctx.consumer.start()

            await new Promise(resolve => setImmediate(resolve))
            sinon.assert.calledOnce(ctx.handlers.crash)
            sinon.assert.calledWithExactly(ctx.handlers.crash, err)
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

          // Sinon can only compare call order for the spy, not for individual
          // calls. Get the ID for each call and compare those to a sorted
          // list. If all peers were consulted in order then the callIds
          // should be ascending.
          const actualCallIds = calls.map(ctx => ctx.callId)
          const sortedCallIds = actualCallIds.slice().sort((a, b) => a.callId - b.callId)
          assert.deepEqual(actualCallIds, sortedCallIds)
        })

        context('handleMessage() fails', () => {
          it('crashes the consumer', async ctx => {
            const err = Symbol()
            ctx.handlers.message.throws(err)
            ctx.peer.messages.canTake.onCall(0).returns(true)
            ctx.peer.messages.take.returns(Symbol())
            ctx.scheduler.asap.yields()

            ctx.consumer.start()
            sinon.assert.calledOnce(ctx.handlers.crash)
            sinon.assert.calledWithExactly(ctx.handlers.crash, err)
          })
        })
      })
    })

    context('no message can be taken', () => {
      it('consults the nonPeerReceiver', ctx => {
        ctx.consumer.start()
        sinon.assert.calledOnce(ctx.nonPeerReceiver.messages.canTake)
      })

      context('a non-peer message can be taken', () => {
        beforeEach(ctx => {
          ctx.nonPeerReceiver.messages.canTake.onCall(0).returns(true)
          ctx.nonPeerReceiver.messages.take.returns([])
        })

        it('schedules handling the message', ctx => {
          ctx.consumer.start()
          sinon.assert.calledOnce(ctx.scheduler.asap)
          sinon.assert.calledWithExactly(ctx.scheduler.asap, null, sinon.match.func)
        })

        it('only takes the message when it can be handled', ctx => {
          ctx.consumer.start()
          sinon.assert.notCalled(ctx.nonPeerReceiver.messages.take)

          ctx.scheduler.asap.firstCall.args[1]()
          sinon.assert.calledOnce(ctx.nonPeerReceiver.messages.take)
        })

        it('creates a peer', ctx => {
          const address = Symbol()
          ctx.nonPeerReceiver.messages.take.returns([address])
          ctx.scheduler.asap.onCall(0).yields()
          ctx.consumer.start()

          sinon.assert.calledOnce(ctx.nonPeerReceiver.createPeer)
          sinon.assert.calledWithExactly(ctx.nonPeerReceiver.createPeer, address)
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
            sinon.assert.calledOnce(ctx.handlers.message)
            sinon.assert.calledWithExactly(ctx.handlers.message, peer, message)
          })

          context('handleMessage() returns a promise', () => {
            context('the promise returned by the scheduler', () => {
              it('adopts the state of the handleMessage() promise', async ctx => {
                const state = Symbol()
                ctx.handlers.message.returns(Promise.resolve(state))
                ctx.nonPeerReceiver.createPeer.returns(Promise.resolve())
                ctx.consumer.start()

                const result = await ctx.scheduler.asap.firstCall.args[1]()
                assert(result === state)
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

              sinon.assert.calledOnce(ctx.handlers.crash)
              sinon.assert.calledWithExactly(ctx.handlers.crash, err)
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

            sinon.assert.calledOnce(ctx.handlers.crash)
            sinon.assert.calledWithExactly(ctx.handlers.crash, err)
          })
        })
      })

      context('no message can be taken', () => {
        it('waits for a message to become available from any peer or the nonPeerReceiver', ctx => {
          ctx.consumer.start()

          for (const { messages } of ctx.peers) {
            sinon.assert.calledOnce(messages.await)
          }
          sinon.assert.calledOnce(ctx.nonPeerReceiver.messages.await)
        })

        context('a message becomes available', () => {
          it('consults the first peer (and so forth…)', async ctx => {
            let available
            ctx.peers[2].messages.await.onCall(0).returns(new Promise(resolve => available = resolve))
            ctx.consumer.start()

            // Reset first round of canTake() calls.
            const canTakes = ctx.peers.map(peer => peer.messages.canTake).concat(ctx.nonPeerReceiver.messages.canTake)
            for (const stub of canTakes) {
              stub.reset()
            }
            sinon.assert.notCalled(canTakes[0])

            // Make a message available for the second peer.
            available()
            await new Promise(resolve => setImmediate(resolve))

            // Each canTake() should be invoked, in order (so first peer goes
            // first).
            sinon.assert.callOrder(...canTakes)
          })
        })

        context('an error occurs', () => {
          it('crashes the consumer', async ctx => {
            const err = Symbol()
            ctx.peers[2].messages.await.onCall(0).returns(Promise.reject(err))

            ctx.consumer.start()
            await new Promise(resolve => setImmediate(resolve))

            sinon.assert.calledOnce(ctx.handlers.crash)
            sinon.assert.calledWithExactly(ctx.handlers.crash, err)
          })
        })
      })
    })
  })

  describe('#stop ()', () => {
    beforeEach(ctx => ctx.canTakes = ctx.peers.map(peer => peer.messages.canTake).concat(ctx.nonPeerReceiver.messages.canTake))

    const noTakes = (ctx, canTakes = ctx.canTakes) => {
      for (const canTake of canTakes) {
        sinon.assert.notCalled(canTake)
      }
    }
    const resetTakes = ctx => {
      for (const canTake of ctx.canTakes) {
        canTake.reset()
      }
      sinon.assert.notCalled(ctx.canTakes[0])
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

            sinon.assert.calledOnce(ctx.canTakes[0])
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
        sinon.assert.calledOnce(ctx.nonPeerReceiver.createPeer)
        ctx.consumer.stop()

        create()
        await Promise.resolve()

        sinon.assert.notCalled(ctx.handlers.message)
      })
    })
  })
})
