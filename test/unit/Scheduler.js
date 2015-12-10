import { beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import { spy, stub } from 'sinon'

import Scheduler from '🏠/lib/Scheduler'

function remainsPending (promise) {
  return new Promise((resolve, reject) => {
    promise.then(
      value => reject(new Error(`Promise was fulfilled with ${value}`)),
      reason => reject(new Error(`Promise was rejected with ${reason}`)))
    // Can't really tell if the promise remains pending, and can't wait too long
    // either of course…
    setImmediate(() => resolve(true))
  })
}

describe('Scheduler', () => {
  beforeEach(ctx => {
    ctx.crashHandler = stub()
    ctx.scheduler = new Scheduler(ctx.crashHandler)
  })

  describe('#asap (handleAbort = null, fn)', () => {
    context('the scheduler was already aborted', () => {
      beforeEach(ctx => ctx.scheduler.abort())

      context('handleAbort is truthy', () => {
        it('is called', ctx => {
          const handleAbort = spy()
          ctx.scheduler.asap(handleAbort)
          assert(handleAbort.calledOnce)
        })
      })

      it('returns a perpetually pending promise', async ctx => {
        assert(await remainsPending(ctx.scheduler.asap()))
      })
    })

    context('no operation is currently active', () => {
      it('calls fn', ctx => {
        const fn = spy()
        ctx.scheduler.asap(null, fn)

        assert(fn.calledOnce)
      })

      context('fn throws', () => {
        it('invokes the crashHandler with the error', ctx => {
          const err = Symbol()
          ctx.scheduler.asap(null, () => { throw err })

          assert(ctx.crashHandler.calledOnce)
          const { args: [reason] } = ctx.crashHandler.firstCall
          assert(reason === err)
        })

        it('returns a perpetually pending promise', async ctx => {
          assert(await remainsPending(ctx.scheduler.asap(null, () => { throw new Error() })))
        })
      })

      context('fn has no return value', () => {
        it('returns undefined', ctx => {
          assert(ctx.scheduler.asap(null, () => {}) === undefined)
        })
      })

      context('fn returns a promise', () => {
        describe('the return value of the call to asap()', () => {
          it('is a promise', ctx => {
            assert(ctx.scheduler.asap(null, () => new Promise(() => {})) instanceof Promise)
          })
        })

        context('the promise returned by fn is fulfilled', () => {
          describe('the promise returned by asap()', () => {
            it('is fulfilled with undefined', async ctx => {
              assert(await ctx.scheduler.asap(null, () => Promise.resolve(Symbol())) === undefined)
            })
          })
        })

        context('the promise returned by fn is rejected', () => {
          it('invokes the crashHandler with the rejection reason', async ctx => {
            const err = Symbol()
            ctx.scheduler.asap(null, () => Promise.reject(err))

            await Promise.resolve()
            assert(ctx.crashHandler.calledOnce)
            const { args: [reason] } = ctx.crashHandler.firstCall
            assert(reason === err)
          })

          describe('the promise returned by asap()', () => {
            it('remains perpetually pending', async ctx => {
              assert(await remainsPending(ctx.scheduler.asap(null, () => Promise.reject())))
            })
          })
        })
      })
    })

    context('another operation is currently active', () => {
      it('prevents two operations from being run at the same time', ctx => {
        ctx.scheduler.asap(null, () => new Promise(() => {}))
        const second = spy()
        ctx.scheduler.asap(null, second)

        assert(second.notCalled)
      })

      it('returns a promise for when the second operation has finished', ctx => {
        ctx.scheduler.asap(null, () => new Promise(() => {}))
        assert(ctx.scheduler.asap(null, () => {}) instanceof Promise)
      })

      describe('the second operation', () => {
        it('is run after the first', async ctx => {
          ctx.scheduler.asap(null, () => Promise.resolve())
          const second = spy()
          await ctx.scheduler.asap(null, second)

          assert(second.calledOnce)
        })
      })

      describe('a third operation', () => {
        it('is run after the second', async ctx => {
          ctx.scheduler.asap(null, () => Promise.resolve())
          const second = spy()
          ctx.scheduler.asap(null, second)
          const third = spy()
          await ctx.scheduler.asap(null, third)

          assert(second.calledBefore(third))
        })
      })
    })
  })

  describe('#abort ()', () => {
    it('stops any remaining operations from being run', async ctx => {
      const first = ctx.scheduler.asap(null, () => Promise.resolve())
      const second = spy()
      ctx.scheduler.asap(null, second)

      ctx.scheduler.abort()
      await first
      assert(second.notCalled)
    })

    it('invokes the handleAbort callbacks of any remaining operations', ctx => {
      const first = spy()
      ctx.scheduler.asap(first, () => Promise.resolve())
      const second = spy()
      ctx.scheduler.asap(second, () => {})
      const third = spy()
      ctx.scheduler.asap(third, () => {})

      ctx.scheduler.abort()
      assert(first.notCalled)
      assert(second.calledBefore(third))
    })
  })
})
