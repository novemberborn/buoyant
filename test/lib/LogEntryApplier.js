import test from 'ava'
import { spy, stub } from 'sinon'

import { Noop } from 'dist/lib/symbols'
import Entry from 'dist/lib/Entry'
import LogEntryApplier from 'dist/lib/LogEntryApplier'

import macro from './helpers/macro'

// Don't use the Promise introduced by babel-runtime. https://github.com/avajs/ava/issues/947
const { Promise } = global

function setupDoApply (context) {
  const { applyEntry } = context
  let doApply
  applyEntry.returns(new Promise(resolve => {
    doApply = result => {
      resolve(result)
      return Promise.resolve()
    }
  }))
  return Object.assign({ doApply }, context)
}

test.beforeEach(t => {
  const applyEntry = stub().returns(Promise.resolve())
  const crashHandler = stub()
  const applier = new LogEntryApplier({ applyEntry, crashHandler })

  Object.assign(t.context, {
    applier,
    applyEntry,
    crashHandler
  })
})

const resetThrowsTypeError = macro((t, lastApplied) => {
  const { applier } = t.context
  t.throws(
    () => applier.reset(lastApplied),
    TypeError,
    'Cannot reset log entry applier: last-applied index must be a safe, non-negative integer')
}, suffix => `reset() throws if the given lastApplied value is ${suffix}`)

test('lastApplied is initialized to 0', t => {
  const { applier } = t.context
  t.true(applier.lastApplied === 0)
})

test('lastQueued is initialized to 0', t => {
  const { applier } = t.context
  t.true(applier.lastQueued === 0)
})

test('not an integer', resetThrowsTypeError, '🙊')
test('not a safe integer', resetThrowsTypeError, Number.MAX_SAFE_INTEGER + 1)
test('lower than 0', resetThrowsTypeError, -1)

test('reset() throws if called while entries are being appended', t => {
  const { applier } = t.context
  applier.enqueue(new Entry(1, 1, Symbol()))
  t.throws(
    () => applier.reset(0),
    Error,
    'Cannot reset log entry applier while entries are being applied')
})

test('reset() sets lastApplied to the lastApplied value', t => {
  const { applier } = t.context
  applier.reset(10)
  t.true(applier.lastApplied === 10)
})

test('reset() sets lastQueued to the lastApplied value', t => {
  const { applier } = t.context
  applier.reset(10)
  t.true(applier.lastQueued === 10)
})

test('enqueue() immediately sets lastQueued to the entry’s index', t => {
  const { applier } = t.context
  applier.enqueue(new Entry(1, 1, Symbol()))
  t.true(applier.lastQueued === 1)
})

test('enqueue() applies the entry', t => {
  const { applier, applyEntry } = t.context
  const entry = new Entry(1, 1, Symbol())
  applier.enqueue(entry)
  t.true(applyEntry.calledOnce)
  const { args: [applied] } = applyEntry.firstCall
  t.true(applied === entry)
})

test('enqueue() sets lastApplied to the entry’s index, once it’s been applied', async t => {
  const { applier, doApply } = setupDoApply(t.context)

  applier.enqueue(new Entry(3, 1, Symbol()))
  t.true(applier.lastApplied === 0)

  await doApply()
  t.true(applier.lastApplied === 3)
})

test('enqueue() prevents two entries being applied at the same time', t => {
  const { applier, applyEntry } = t.context
  applier.enqueue(new Entry(1, 1, Symbol()))
  applier.enqueue(new Entry(2, 1, Symbol()))
  t.true(applyEntry.calledOnce)
})

test('enqueue() applies one entry after the other', async t => {
  const { applier, applyEntry } = t.context
  const first = new Entry(1, 1, Symbol())
  const second = new Entry(2, 1, Symbol())

  const firstApplied = spy()
  applier.enqueue(first, firstApplied)

  await new Promise(resolve => {
    applier.enqueue(second, () => {
      t.true(firstApplied.calledOnce)
      resolve()
    })
  })

  t.true(applyEntry.calledTwice)
  const { args: [[actualFirst], [actualSecond]] } = applyEntry
  t.true(actualFirst === first)
  t.true(actualSecond === second)
})

test('enqueue() calls the resolve callback with the result of applying the entry', async t => {
  const { applier, doApply } = setupDoApply(t.context)
  const wasApplied = spy()
  applier.enqueue(new Entry(1, 1, Symbol()), wasApplied)

  const result = Symbol()
  await doApply(result)

  t.true(wasApplied.calledOnce)
  const { args: [applicationResult] } = wasApplied.firstCall
  t.true(applicationResult === result)
})

test('enqueue() does not apply Noop entries', async t => {
  const { applier, applyEntry } = t.context
  await new Promise(resolve => {
    applier.enqueue(new Entry(1, 1, Noop), resolve)
  })

  t.true(applyEntry.notCalled)
})

test('enqueue() sets lastApplied to the entry’s index, even if it is a Noop entry', async t => {
  const { applier } = t.context
  await new Promise(resolve => {
    applier.enqueue(new Entry(3, 1, Noop), resolve)
  })

  t.true(applier.lastApplied === 3)
})

test('enqueue() calls the resolve callback with an undefined result when enqueuing a Noop entry', async t => {
  const { applier } = t.context
  const result = new Promise(resolve => {
    applier.enqueue(new Entry(3, 1, Noop), resolve)
  })

  t.true(await result === undefined)
})

test('the crashHandler is called if an entry cannot be applied', async t => {
  const { applier, crashHandler, doApply } = setupDoApply(t.context)
  applier.enqueue(new Entry(1, 1, Symbol()))

  const err = Symbol()
  doApply(Promise.reject(err))
  await new Promise(resolve => setImmediate(resolve))

  t.true(crashHandler.calledOnce)
  const { args: [reason] } = crashHandler.firstCall
  t.true(reason === err)
})

test('finish() returns a fulfilled promise if no entries are being applied', async t => {
  const { applier } = t.context
  t.true(await applier.finish() === undefined)
})

test('finish() returns a promise that is fulfilled when the last entry has been applied', async t => {
  const { applier, doApply } = setupDoApply(t.context)
  const wasApplied = spy()
  applier.enqueue(new Entry(1, 1, Symbol()), wasApplied)

  const finished = spy()
  const promise = applier.finish().then(finished)

  t.true(wasApplied.notCalled)
  doApply()
  await promise

  t.true(wasApplied.calledBefore(finished))
  const { args: [value] } = finished.firstCall
  t.true(value === undefined)
})

test('destroy() stops any remaining entries from being applied', async t => {
  const { applier, applyEntry } = t.context
  const firstApplied = new Promise(resolve => {
    applier.enqueue(new Entry(1, 1, Symbol()), resolve)
  })
  applier.enqueue(new Entry(2, 1, Symbol()))

  t.true(applyEntry.calledOnce)
  applier.destroy()

  await firstApplied
  t.true(applyEntry.calledOnce)
})
