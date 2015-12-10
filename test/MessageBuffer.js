import { beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import { stub } from 'sinon'

import MessageBuffer from '../lib/MessageBuffer'

describe('MessageBuffer', () => {
  beforeEach(ctx => {
    ctx.stream = stub({
      read () {},
      once () {}
    })
    ctx.stream.read.returns(null)
    ctx.buffer = new MessageBuffer(ctx.stream)
  })

  describe('#take ()', () => {
    it('reads from the stream', ctx => {
      const message = Symbol()
      ctx.stream.read.onCall(0).returns(message)

      assert(ctx.buffer.take() === message)
      assert(ctx.stream.read.calledOnce)
    })

    context('a buffered message is available', () => {
      beforeEach(ctx => {
        ctx.message = Symbol()
        ctx.stream.read.onCall(0).returns(ctx.message)
        ctx.buffer.canTake()
        assert(ctx.stream.read.calledOnce)
      })

      it('returns that message', ctx => {
        assert(ctx.buffer.take() === ctx.message)
        assert(ctx.stream.read.calledOnce)
      })

      context('taking another message immediately after', () => {
        it('reads from the stream', ctx => {
          const another = Symbol()
          ctx.stream.read.onCall(1).returns(another)
          ctx.buffer.take()

          assert(ctx.buffer.take() === another)
          assert(ctx.stream.read.calledTwice)
        })
      })
    })
  })

  describe('#canTake ()', () => {
    context('there is no buffered message', () => {
      it('reads from the stream', ctx => {
        ctx.stream.read.onCall(0).returns(Symbol())

        ctx.buffer.canTake()
        assert(ctx.stream.read.calledOnce)
      })

      context('a message was read', () => {
        it('returns true', ctx => {
          ctx.stream.read.onCall(0).returns(Symbol())
          assert(ctx.buffer.canTake() === true)
        })
      })

      context('no message was read', () => {
        it('returns false', ctx => {
          assert(ctx.buffer.canTake() === false)
        })
      })
    })

    it('returns whether there is a buffered message', ctx => {
      ctx.stream.read.onCall(0).returns(Symbol())
      ctx.buffer.canTake()

      assert(ctx.buffer.canTake() === true)
    })
  })

  describe('#await ()', () => {
    context('there is no buffered message', () => {
      it('reads from the stream', ctx => {
        ctx.stream.read.onCall(0).returns(Symbol())

        ctx.buffer.await()
        assert(ctx.stream.read.calledOnce)
      })

      context('a message was read', () => {
        beforeEach(ctx => ctx.stream.read.onCall(0).returns(Symbol()))

        it('returns a fulfilled promise', async ctx => {
          assert(await ctx.buffer.await() === undefined)
        })

        context('called repeatedly', () => {
          context('before fulfillment could be observed', () => {
            it('returns the same promise', ctx => {
              assert(ctx.buffer.await() === ctx.buffer.await())
            })
          })

          context('after fulfillment could be observed', () => {
            it('returns a different promise', async ctx => {
              const p = ctx.buffer.await()
              await p
              assert(ctx.buffer.await() !== p)
            })
          })
        })
      })

      context('no message was read', () => {
        it('listens for the readable event', ctx => {
          ctx.buffer.await()
          assert(ctx.stream.once.calledOnce)
          const { args: [event, listener] } = ctx.stream.once.firstCall
          assert(event === 'readable')
          assert(typeof listener === 'function')
        })

        context('the readable event fires', () => {
          it('fulfills the returned promise', async ctx => {
            const p = ctx.buffer.await()
            const { args: [, fire] } = ctx.stream.once.firstCall

            fire()
            assert(await p === undefined)
          })
        })

        context('called repeatedly', () => {
          context('before the returned promise is fulfilled', () => {
            it('returns the same promise', ctx => {
              assert(ctx.buffer.await() === ctx.buffer.await())
            })
          })

          context('after the returned promise is fulfilled', () => {
            it('returns a different promise', async ctx => {
              const p = ctx.buffer.await()
              const { args: [, fire] } = ctx.stream.once.firstCall

              fire()
              await p
              assert(ctx.buffer.await() !== p)
            })
          })
        })
      })
    })
  })
})
