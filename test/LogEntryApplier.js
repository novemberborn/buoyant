import { beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import sinon from 'sinon'

import { Noop } from '../lib/symbols'
import Entry from '../lib/Entry'
import LogEntryApplier from '../lib/LogEntryApplier'

describe('LogEntryApplier', () => {
  beforeEach(ctx => {
    const applyEntry = ctx.applyEntry = sinon.stub().returns(Promise.resolve())
    const crashHandler = ctx.crashHandler = sinon.stub()
    ctx.applier = new LogEntryApplier({ applyEntry, crashHandler })
  })

  describe('constructor ({ applyEntry, crashHandler })', () => {
    it('initializes lastApplied to 0', ctx => {
      assert(ctx.applier.lastApplied === 0)
    })

    it('initializes lastQueued to 0', ctx => {
      assert(ctx.applier.lastQueued === 0)
    })
  })

  describe('#reset (lastApplied)', () => {
    ;[
      { desc: 'not an integer', value: '🙊' },
      { desc: 'not a safe integer', value: Number.MAX_SAFE_INTEGER + 1 },
      { desc: 'lower than 0', value: -1 }
    ].forEach(({ desc, value }) => {
      context(`lastApplied is ${desc}`, () => {
        it('throws a TypeError', ctx => {
          assert.throws(
            () => ctx.applier.reset(value),
            TypeError,
            'Cannot reset log entry applier: last-applied index must be a safe, non-negative integer')
        })
      })
    })

    context('called while entries are being appended', () => {
      it('throws an Error', ctx => {
        ctx.applier.enqueue(new Entry(1, 1, Symbol()))
        assert.throws(
          () => ctx.applier.reset(0),
          Error,
          'Cannot reset log entry applier while entries are being applied')
      })
    })

    it('sets lastApplied to the lastApplied value', ctx => {
      ctx.applier.reset(10)
      assert(ctx.applier.lastApplied === 10)
    })

    it('sets lastQueued to the lastApplied value', ctx => {
      ctx.applier.reset(10)
      assert(ctx.applier.lastQueued === 10)
    })
  })

  describe('#enqueue (entry, resolve = null)', () => {
    it('sets lastQueued to the entry’s index', ctx => {
      ctx.applier.enqueue(new Entry(1, 1, Symbol()))
      assert(ctx.applier.lastQueued === 1)
    })

    context('when an entry is already being applied', () => {
      it('prevents two entries being applied at the same time', ctx => {
        ctx.applier.enqueue(new Entry(1, 1, Symbol()))
        ctx.applier.enqueue(new Entry(2, 1, Symbol()))
        sinon.assert.calledOnce(ctx.applyEntry)
      })

      describe('the second entry', () => {
        it('is applied after the first', async ctx => {
          const entries = [new Entry(1, 1, Symbol()), new Entry(2, 1, Symbol())]
          const firstApplied = sinon.spy()
          ctx.applier.enqueue(entries[0], firstApplied)
          await new Promise(resolve => {
            ctx.applier.enqueue(entries[1], () => {
              sinon.assert.calledOnce(firstApplied)
              resolve()
            })
          })

          sinon.assert.calledTwice(ctx.applyEntry)
          assert(ctx.applyEntry.getCall(0).args[0] === entries[0])
          assert(ctx.applyEntry.getCall(1).args[0] === entries[1])
        })
      })

      describe('a third entry', () => {
        it('is applied after the second', async ctx => {
          const entries = [new Entry(1, 1, Symbol()), new Entry(2, 1, Symbol()), new Entry(3, 1, Symbol())]
          const firstApplied = sinon.spy()
          ctx.applier.enqueue(entries[0], firstApplied)
          const secondApplied = sinon.spy()
          ctx.applier.enqueue(entries[1], secondApplied)
          await new Promise(resolve => {
            ctx.applier.enqueue(entries[2], () => {
              sinon.assert.callOrder(firstApplied, secondApplied)
              resolve()
            })
          })

          sinon.assert.calledThrice(ctx.applyEntry)
          assert(ctx.applyEntry.getCall(0).args[0] === entries[0])
          assert(ctx.applyEntry.getCall(1).args[0] === entries[1])
          assert(ctx.applyEntry.getCall(2).args[0] === entries[2])
        })
      })
    })

    context('no other entries are being applied', () => {
      it('applies the entry', ctx => {
        const entry = new Entry(1, 1, Symbol())
        ctx.applier.enqueue(entry)
        sinon.assert.calledOnce(ctx.applyEntry)
        sinon.assert.calledWithExactly(ctx.applyEntry, entry)
      })

      context('applying the entry succeeded', () => {
        it('sets lastApplied to the entry’s index', async ctx => {
          let doApply
          ctx.applyEntry.returns(new Promise(resolve => doApply = resolve))

          ctx.applier.enqueue(new Entry(3, 1, Symbol()))
          assert(ctx.applier.lastApplied === 0)

          doApply()
          await Promise.resolve()
          assert(ctx.applier.lastApplied === 3)
        })

        context('there is a resolve callback for the entry', () => {
          it('is called with the result', async ctx => {
            let doApply
            ctx.applyEntry.returns(new Promise(resolve => doApply = resolve))

            const wasApplied = sinon.spy()
            ctx.applier.enqueue(new Entry(1, 1, Symbol()), wasApplied)

            const result = Symbol()
            doApply(result)
            await Promise.resolve()
            sinon.assert.calledOnce(wasApplied)
            sinon.assert.calledWithExactly(wasApplied, result)
          })
        })
      })

      context('applying the entry failed', () => {
        describe('the crashHandler', () => {
          it('is called with the error', async ctx => {
            let doFail
            ctx.applyEntry.returns(new Promise((_, reject) => doFail = reject))

            ctx.applier.enqueue(new Entry(1, 1, Symbol()))

            const err = Symbol()
            doFail(err)
            await Promise.resolve()
            sinon.assert.calledOnce(ctx.crashHandler)
            sinon.assert.calledWithExactly(ctx.crashHandler, err)
          })
        })
      })

      context('the entry has a Noop value', () => {
        it('does not actually apply the entry', async ctx => {
          await new Promise(resolve => {
            ctx.applier.enqueue(new Entry(1, 1, Noop), resolve)
          })

          sinon.assert.notCalled(ctx.applyEntry)
        })

        it('does set lastApplied to the entry’s index', async ctx => {
          await new Promise(resolve => {
            ctx.applier.enqueue(new Entry(3, 1, Noop), resolve)
          })

          assert(ctx.applier.lastApplied === 3)
        })

        context('there is a resolve callback for the entry', () => {
          it('is called (without a result)', async ctx => {
            const result = new Promise(resolve => {
              ctx.applier.enqueue(new Entry(3, 1, Noop), resolve)
            })

            assert(await result === undefined)
          })
        })
      })
    })
  })

  describe('#finish ()', () => {
    context('no entries are being applied', () => {
      it('returns a fulfilled promise', async ctx => {
        assert(await ctx.applier.finish() === undefined)
      })
    })

    context('entries are being applied', () => {
      it('returns a promise that is fulfilled when the last entry has been applied', async ctx => {
        let doApply
        ctx.applyEntry.returns(new Promise(resolve => doApply = resolve))

        const wasApplied = sinon.spy()
        ctx.applier.enqueue(new Entry(1, 1, Symbol()), wasApplied)

        const finished = sinon.spy()
        const p = ctx.applier.finish().then(finished)

        sinon.assert.notCalled(wasApplied)
        doApply()
        await p
        sinon.assert.callOrder(wasApplied, finished)
        sinon.assert.calledWithExactly(finished, undefined)
      })

      it('does not change the lastQueued value', ctx => {
        ctx.applier.enqueue(new Entry(1, 1, Symbol()))
        const { lastQueued } = ctx.applier

        ctx.applier.finish()
        assert(ctx.applier.lastQueued === lastQueued)
      })
    })
  })

  describe('#destroy ()', () => {
    it('stops any remaining entries from being applied', async ctx => {
      const firstApplied = new Promise(resolve => {
        ctx.applier.enqueue(new Entry(1, 1, Symbol()), resolve)
      })
      ctx.applier.enqueue(new Entry(2, 1, Symbol()))

      sinon.assert.calledOnce(ctx.applyEntry)
      ctx.applier.destroy()

      await firstApplied
      sinon.assert.calledOnce(ctx.applyEntry)
    })
  })
})
