import { beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import { stub } from 'sinon'

import Entry from '../lib/Entry'
import Log from '../lib/Log'

describe('Log', () => {
  beforeEach(ctx => {
    const persistEntries = ctx.persistEntries = stub().returns(Promise.resolve())
    const applier = ctx.applier = stub({
      _lastQueued () {},
      get lastQueued () { return this._lastQueued() },
      finish () {},
      destroy () {},
      reset () {},
      enqueue () {}
    })
    ctx.applier._lastQueued.returns(0)
    ctx.log = new Log({ persistEntries, applier })
  })

  const seedEntries = async ctx => {
    const entries = [1, 2, 3].map(index => new Entry(index, 1, Symbol(`seed entry ${index}`)))
    await ctx.log.mergeEntries(entries)
    ctx.persistEntries.resetHistory()
    return entries
  }

  const makeEntries = (index, term, count) => {
    const entries = []
    for (; entries.length < count; index++) {
      entries.push(new Entry(index, term, Symbol()))
    }
    return entries
  }

  describe('constructor ({ persistEntries, applier })', () => {
    it('initializes lastIndex to 0', ctx => {
      assert(ctx.log.lastIndex === 0)
    })

    it('initializes lastTerm to 0', ctx => {
      assert(ctx.log.lastTerm === 0)
    })
  })

  describe('#close ()', () => {
    it('invokes finish() on the applier and returns the result', ctx => {
      const result = Symbol()
      ctx.applier.finish.returns(result)
      assert(ctx.log.close() === result)
    })
  })

  describe('#destroy ()', () => {
    it('invokes destroy() on the applier', ctx => {
      ctx.log.destroy()
      assert(ctx.applier.destroy.calledOnce)
    })

    it('returns undefined', ctx => {
      const result = Symbol()
      ctx.applier.destroy.returns(result)
      assert(ctx.log.destroy() === undefined)
    })
  })

  describe('#replace (entries, lastApplied = 0)', () => {
    it('invokes reset() on the applier, with the lastApplied value', ctx => {
      const lastApplied = Symbol()
      ctx.log.replace([], lastApplied)
      assert(ctx.applier.reset.calledOnce)
      const { args: [to] } = ctx.applier.reset.firstCall
      assert(to === lastApplied)
    })

    context('no lastApplied value was provided', () => {
      it('invokes reset() on the applier, with the default lastApplied value of 0', ctx => {
        ctx.log.replace([])
        assert(ctx.applier.reset.calledOnce)
        const { args: [to] } = ctx.applier.reset.firstCall
        assert(to === 0)
      })
    })

    it('clears previous entries', async ctx => {
      const previous = await seedEntries(ctx)
      for (const entry of previous) {
        assert(ctx.log.getEntry(entry.index) === entry)
      }

      const entries = makeEntries(1, 1, 3)
      ctx.log.replace(entries)
      for (const entry of previous) {
        assert(ctx.log.getEntry(entry.index) !== entry)
      }
    })

    context('there are no new entries', () => {
      beforeEach(async ctx => await seedEntries(ctx))

      it('resets lastIndex to 0', ctx => {
        assert(ctx.log.lastIndex > 0)
        ctx.log.replace([])
        assert(ctx.log.lastIndex === 0)
      })

      it('resets lastTerm to 0', ctx => {
        assert(ctx.log.lastTerm > 0)
        ctx.log.replace([])
        assert(ctx.log.lastTerm === 0)
      })
    })

    context('there are new entries', () => {
      it('sets each entry', ctx => {
        const entries = makeEntries(1, 1, 3)
        ctx.log.replace(entries)
        for (const entry of entries) {
          assert(ctx.log.getEntry(entry.index) === entry)
        }
      })

      it('sets lastIndex to the index of the last entry', ctx => {
        const entries = makeEntries(1, 1, 3)
        ctx.log.replace(entries)
        assert(ctx.log.lastIndex === 3)
      })

      it('sets lastTerm to the term of the last entry', ctx => {
        const entries = makeEntries(1, 1, 2).concat(new Entry(3, 3, Symbol()))
        ctx.log.replace(entries)
        assert(ctx.log.lastTerm === 3)
      })

      context('later entries conflict with earlier ones', () => {
        it('deletes the earlier, conflicting entries', ctx => {
          const entries = makeEntries(1, 1, 3).concat(makeEntries(2, 1, 3))
          ctx.log.replace(entries)
          assert(ctx.log.getEntry(1) === entries[0])
          for (const entry of entries.slice(1, 3)) {
            assert(ctx.log.getEntry(entry.index) !== entry)
          }
          for (const entry of entries.slice(3)) {
            assert(ctx.log.getEntry(entry.index) === entry)
          }
        })
      })
    })
  })

  describe('#deleteConflictingEntries (fromIndex)', () => {
    it('deletes all entries in order, starting at fromIndex', async ctx => {
      const entries = await seedEntries(ctx)
      ctx.log.deleteConflictingEntries(2)
      assert(ctx.log.getEntry(1) === entries[0])
      assert(ctx.log.getEntry(2) === undefined)
      assert(ctx.log.getEntry(3) === undefined)
    })
  })

  describe('#getTerm (index)', () => {
    beforeEach(async ctx => await seedEntries(ctx))

    context('index is 0', () => {
      it('returns 0', ctx => {
        assert(ctx.log.getTerm(0) === 0)
      })
    })

    it('returns the term for the entry at the given index', ctx => {
      assert(ctx.log.getTerm(1) === 1)
    })

    context('no entry exists at the given index', () => {
      it('throws a TypeError', ctx => {
        assert.throws(() => ctx.log.getTerm(4), TypeError)
      })
    })
  })

  describe('#getEntry (index)', () => {
    it('returns the entry at the given index', ctx => {
      const entry = new Entry(1, 1, Symbol())
      ctx.log.replace([entry])
      assert(ctx.log.getEntry(1) === entry)
    })

    context('no entry exists at the given index', () => {
      it('returns undefined', ctx => {
        assert(ctx.log.getEntry(1) === undefined)
      })
    })
  })

  describe('#getEntriesSince (index)', () => {
    it('returns all entries in order, starting at index', async ctx => {
      const entries = await seedEntries(ctx)
      const since = ctx.log.getEntriesSince(2)
      assert(since.length === 2)
      assert(since[0] === entries[1])
      assert(since[1] === entries[2])
    })
  })

  describe('#appendValue (currentTerm, value)', () => {
    it('persists an entry for the value', ctx => {
      const value = Symbol()
      ctx.log.appendValue(1, value)

      assert(ctx.persistEntries.calledOnce)
      const { args: [[entry]] } = ctx.persistEntries.firstCall
      assert(entry.value === value)
    })

    context('the persisted entry’s index', () => {
      it('is 1 higher than that of the last entry in the log', async ctx => {
        const last = (await seedEntries(ctx)).pop()
        ctx.log.appendValue(1, Symbol())
        const { args: [[entry]] } = ctx.persistEntries.firstCall

        assert(entry.index === last.index + 1)
      })
    })

    context('the persisted entry’s term', () => {
      it('is the currentTerm', ctx => {
        ctx.log.appendValue(2, Symbol())
        const { args: [[entry]] } = ctx.persistEntries.firstCall

        assert(entry.term === 2)
      })
    })

    context('after the entry has been persisted', () => {
      beforeEach(ctx => {
        ctx.persistEntries.returns(new Promise(resolve => ctx.finishPersist = resolve))
      })

      it('sets lastIndex', async ctx => {
        const p = ctx.log.appendValue(1, Symbol())
        assert(ctx.log.lastIndex === 0)

        ctx.finishPersist()
        await p
        assert(ctx.log.lastIndex === 1)
      })

      it('sets lastTerm', async ctx => {
        const p = ctx.log.appendValue(1, Symbol())
        assert(ctx.log.lastTerm === 0)

        ctx.finishPersist()
        await p
        assert(ctx.log.lastTerm === 1)
      })

      it('sets the new entry', async ctx => {
        const p = ctx.log.appendValue(1, Symbol())
        assert(ctx.log.getEntry(1) === undefined)

        const { args: [[entry]] } = ctx.persistEntries.firstCall
        ctx.finishPersist()

        await p
        assert(ctx.log.getEntry(1) === entry)
      })

      it('fulfills the returned promise with the entry', async ctx => {
        const p = ctx.log.appendValue(1, Symbol())
        assert(ctx.log.lastIndex === 0)

        const { args: [[entry]] } = ctx.persistEntries.firstCall
        ctx.finishPersist()
        assert(await p === entry)
      })
    })
  })

  describe('#mergeEntries (entries)', () => {
    it('persists the entries', ctx => {
      const entries = makeEntries(1, 1, 3)
      ctx.log.mergeEntries(entries)

      const { args: [persisting] } = ctx.persistEntries.firstCall
      assert(persisting.length === 3)
      assert(persisting[0] === entries[0])
      assert(persisting[1] === entries[1])
      assert(persisting[2] === entries[2])
    })

    context('there are duplicate entries', () => {
      it('does not persist the duplicates', async ctx => {
        const existing = await seedEntries(ctx)
        const extra = new Entry(4, 1, Symbol())
        ctx.log.mergeEntries(existing.slice(1).concat(extra))

        const { args: [persisting] } = ctx.persistEntries.firstCall
        assert(persisting.length === 1)
        assert(persisting[0] === extra)
      })
    })

    context('there are no new entries to be merged', () => {
      it('returns a fulfilled promise, without persisting', async ctx => {
        const existing = await seedEntries(ctx)
        await ctx.log.mergeEntries(existing)
        assert(ctx.persistEntries.notCalled)
      })
    })

    context('after the entries have been persisted', () => {
      const makeFinisher = ctx => {
        ctx.persistEntries.returns(new Promise(resolve => ctx.finishPersist = resolve))
      }
      beforeEach(makeFinisher)

      it('sets each entry', async ctx => {
        const entries = makeEntries(1, 1, 3)
        const p = ctx.log.mergeEntries(entries)
        assert(ctx.log.getEntry(1) === undefined)

        ctx.finishPersist()
        await p
        for (const entry of entries) {
          assert(ctx.log.getEntry(entry.index) === entry)
        }
      })

      context('later entries conflict with earlier ones', () => {
        it('deletes the earlier, conflicting entries', async ctx => {
          // Revert persistEntries() behavior so entries can be seeded.
          ctx.persistEntries.returns(Promise.resolve())
          const earlier = await seedEntries(ctx)
          makeFinisher(ctx)

          const entries = makeEntries(2, 2, 3)
          const p = ctx.log.mergeEntries(entries)
          assert(ctx.log.getEntry(2) === earlier[1])

          ctx.finishPersist()
          await p
          assert(ctx.log.getEntry(1) === earlier[0])
          for (const entry of entries) {
            assert(ctx.log.getEntry(entry.index) === entry)
          }
        })
      })

      it('sets lastIndex to the index of the last entry', async ctx => {
        const entries = makeEntries(1, 1, 3)
        const p = ctx.log.mergeEntries(entries)
        assert(ctx.log.lastIndex === 0)

        ctx.finishPersist()
        await p
        assert(ctx.log.lastIndex === entries.pop().index)
      })

      it('sets lastTerm to the term of the last entry', async ctx => {
        const entries = makeEntries(1, 1, 2).concat(new Entry(3, 2, Symbol()))
        const p = ctx.log.mergeEntries(entries)
        assert(ctx.log.lastTerm === 0)

        ctx.finishPersist()
        await p
        assert(ctx.log.lastTerm === entries.pop().term)
      })
    })
  })

  describe('#commit (index)', () => {
    it('invokes enqueue() on the applier, with the entry at the given index', async ctx => {
      const entry = await ctx.log.appendValue(1, Symbol())
      ctx.log.commit(entry.index)

      assert(ctx.applier.enqueue.calledOnce)
      const { args: [enqueued, resolve] } = ctx.applier.enqueue.firstCall
      assert(enqueued === entry)
      assert(typeof resolve === 'function')
    })

    context('there are earlier uncommitted entries', () => {
      it('enqueues each entry up to and including the one at index, in order', async ctx => {
        const entries = await seedEntries(ctx)
        const latest = await ctx.log.appendValue(1, Symbol())
        ctx.applier._lastQueued.returns(1)
        ctx.log.commit(latest.index)

        assert(ctx.applier.enqueue.calledThrice)
        for (let n = 0; n < 3; n++) {
          const { args: [entry, resolve] } = ctx.applier.enqueue.getCall(n)
          if (n === 0) {
            assert(entry === entries[1])
          } else if (n === 1) {
            assert(entry === entries[2])
          } else {
            assert(entry === latest)
          }

          if (n < 2) {
            assert(resolve === undefined)
          } else {
            assert(typeof resolve === 'function')
          }
        }
      })
    })

    context('the index at entry is committed', () => {
      it('fulfills the returned promise with the result', async ctx => {
        const entry = await ctx.log.appendValue(1, Symbol())
        const p = ctx.log.commit(entry.index)

        const { args: [, resolve] } = ctx.applier.enqueue.firstCall
        const result = Symbol()
        resolve(result)
        assert(await p === result)
      })
    })
  })
})
