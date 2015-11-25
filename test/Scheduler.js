import { beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import sinon from 'sinon'

import Scheduler from '../lib/Scheduler'

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
    ctx.crashHandler = sinon.stub()
    ctx.scheduler = new Scheduler(ctx.crashHandler)
  })

  describe('#asap (handleAbort = null, fn)', () => {
    context('the scheduler was already aborted', () => {
      beforeEach(ctx => ctx.scheduler.abort())

      context('handleAbort is truthy', () => {
        it('is called', ctx => {
          const handleAbort = sinon.spy()
          ctx.scheduler.asap(handleAbort)
          sinon.assert.calledOnce(handleAbort)
        })
      })

      it('returns a perpetually pending promise', async ctx => {
        assert(await remainsPending(ctx.scheduler.asap()))
      })
    })

    context('no operation is currently active', () => {
      it('calls fn', ctx => {
        const fn = sinon.spy()
        ctx.scheduler.asap(null, fn)

        sinon.assert.calledOnce(fn)
      })

      context('fn throws', () => {
        it('invokes the crashHandler with the error', ctx => {
          const err = Symbol()
          ctx.scheduler.asap(null, () => { throw err })

          sinon.assert.calledOnce(ctx.crashHandler)
          sinon.assert.calledWithExactly(ctx.crashHandler, err)
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
            sinon.assert.calledOnce(ctx.crashHandler)
            sinon.assert.calledWithExactly(ctx.crashHandler, err)
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
        const second = sinon.spy()
        ctx.scheduler.asap(null, second)

        sinon.assert.notCalled(second)
      })

      it('returns a promise for when the second operation has finished', ctx => {
        ctx.scheduler.asap(null, () => new Promise(() => {}))
        assert(ctx.scheduler.asap(null, () => {}) instanceof Promise)
      })

      describe('the second operation', () => {
        it('is run after the first', async ctx => {
          ctx.scheduler.asap(null, () => Promise.resolve())
          const second = sinon.spy()
          await ctx.scheduler.asap(null, second)

          sinon.assert.calledOnce(second)
        })
      })

      describe('a third operation', () => {
        it('is run after the second', async ctx => {
          ctx.scheduler.asap(null, () => Promise.resolve())
          const second = sinon.spy()
          ctx.scheduler.asap(null, second)
          const third = sinon.spy()
          await ctx.scheduler.asap(null, third)

          sinon.assert.callOrder(second, third)
        })
      })
    })
  })

  describe('#abort ()', () => {
    it('stops any remaining operations from being run', async ctx => {
      const first = ctx.scheduler.asap(null, () => Promise.resolve())
      const second = sinon.spy()
      ctx.scheduler.asap(null, second)

      ctx.scheduler.abort()
      await first
      sinon.assert.notCalled(second)
    })

    it('invokes the handleAbort callbacks of any remaining operations', ctx => {
      const first = sinon.spy()
      ctx.scheduler.asap(first, () => Promise.resolve())
      const second = sinon.spy()
      ctx.scheduler.asap(second, () => {})
      const third = sinon.spy()
      ctx.scheduler.asap(third, () => {})

      ctx.scheduler.abort()
      sinon.assert.notCalled(first)
      sinon.assert.callOrder(second, third)
    })
  })
})
