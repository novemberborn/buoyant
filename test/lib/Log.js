import test from 'ava'
import { stub } from 'sinon'

import Entry from 'dist/lib/Entry'
import Log from 'dist/lib/Log'

import fork from './helpers/fork-context'
import macro from './helpers/macro'

// Don't use the Promise introduced by babel-runtime. https://github.com/avajs/ava/issues/947
const { Promise } = global

function makeEntries (index, term, count) {
  const entries = []
  for (; entries.length < count; index++) {
    entries.push(new Entry(index, term, Symbol()))
  }
  return entries
}

function setupResolvePersistEntries (context) {
  const { persistEntries } = context
  let resolvePersistEntries
  persistEntries.returns(new Promise(resolve => {
    resolvePersistEntries = resolve
  }))
  return Object.assign({ resolvePersistEntries }, context)
}

test.beforeEach(t => {
  const applier = stub({
    _lastQueued () {},
    get lastQueued () { return this._lastQueued() },
    finish () {},
    destroy () {},
    reset () {},
    enqueue () {}
  })
  applier._lastQueued.returns(0)

  const persistEntries = stub().returns(Promise.resolve())

  const log = new Log({ applier, persistEntries })

  Object.assign(t.context, {
    applier,
    log,
    persistEntries
  })
})

const preseeded = fork().beforeEach(async t => {
  const { log, persistEntries } = t.context
  const entries = [1, 2, 3].map(index => new Entry(index, 1, Symbol(`seed entry ${index}`)))
  await log.mergeEntries(entries)
  persistEntries.reset()
  Object.assign(t.context, { entries })
})

const persistingAppend = fork().beforeEach(t => {
  const { log, persistEntries, resolvePersistEntries } = setupResolvePersistEntries(t.context)
  const promise = log.appendValue(1, Symbol)
  const finish = () => {
    resolvePersistEntries()
    return promise
  }
  const { args: [[entry]] } = persistEntries.firstCall
  Object.assign(t.context, { entry, finish })
})

const replaceResetsApplier = macro((t, lastApplied) => {
  const { applier, log } = t.context
  log.replace([], ...(lastApplied ? [lastApplied] : []))

  t.true(applier.reset.calledOnce)
  const { args: [to] } = applier.reset.firstCall
  const expected = lastApplied || 0
  t.true(to === expected)
}, suffix => `replace() invokes reset() on the applier, ${suffix}`)

test('lastIndex is initialized to 0', t => {
  const { log } = t.context
  t.true(log.lastIndex === 0)
})

test('lastTerm is initialized to 0', t => {
  const { log } = t.context
  t.true(log.lastTerm === 0)
})

test('close() invokes finish() on the applier and returns the result', t => {
  const { applier, log } = t.context
  const result = Symbol()
  applier.finish.returns(result)
  t.true(log.close() === result)
})

test('destroy() invokes destroy() on the applier', t => {
  const { applier, log } = t.context
  log.destroy()
  t.true(applier.destroy.calledOnce)
})

test('with the lastApplied value (if provided)', replaceResetsApplier)
test('with the default lastApplied value of 0 (if necessary)', replaceResetsApplier)

preseeded.test('replace() clears previous entries', t => {
  const { entries, log } = t.context
  for (const entry of entries) {
    t.true(log.getEntry(entry.index) === entry)
  }

  log.replace(makeEntries(1, 1, 3))
  for (const entry of entries) {
    t.true(log.getEntry(entry.index) !== entry)
  }
})

preseeded.test('without new entries, replace() resets lastIndex to 0', t => {
  const { log } = t.context
  t.true(log.lastIndex > 0)
  log.replace([])
  t.true(log.lastIndex === 0)
})

preseeded.test('without new entries, replace() resets lastTerm to 0', t => {
  const { log } = t.context
  t.true(log.lastTerm > 0)
  log.replace([])
  t.true(log.lastTerm === 0)
})

test('replace() adds each new entry', t => {
  const { log } = t.context
  const entries = makeEntries(1, 1, 3)
  log.replace(entries)
  for (const entry of entries) {
    t.true(log.getEntry(entry.index) === entry)
  }
})

test('replace() sets lastIndex to the index of the last entry', t => {
  const { log } = t.context
  const entries = makeEntries(1, 1, 3)
  log.replace(entries)
  t.true(log.lastIndex === 3)
})

test('replace() sets lastTerm to the term of the last entry', t => {
  const { log } = t.context
  const entries = makeEntries(1, 1, 2).concat(new Entry(3, 3, Symbol()))
  log.replace(entries)
  t.true(log.lastTerm === 3)
})

test('replace() skips conflicting entries', t => {
  const { log } = t.context
  const entries = makeEntries(1, 1, 3).concat(makeEntries(2, 1, 3))
  log.replace(entries)

  t.true(log.getEntry(1) === entries[0])
  for (const entry of entries.slice(1, 3)) {
    t.true(log.getEntry(entry.index) !== entry)
  }
  for (const entry of entries.slice(3)) {
    t.true(log.getEntry(entry.index) === entry)
  }
})

preseeded.test('deleteConflictingEntries() deletes all entries in order, starting at fromIndex', t => {
  const { entries, log } = t.context
  log.deleteConflictingEntries(2)
  t.true(log.getEntry(1) === entries[0])
  t.true(log.getEntry(2) === undefined)
  t.true(log.getEntry(3) === undefined)
})

preseeded.test('getTerm() returns 0 when the given index is 0', t => {
  const { log } = t.context
  t.true(log.getTerm(0) === 0)
})

preseeded.test('getTerm() returns the term for the entry at the given index', t => {
  const { log } = t.context
  t.true(log.getTerm(1) === 1)
})

preseeded.test('getTerm() throws a TypeError if no entry exists at the given index', t => {
  const { log } = t.context
  t.throws(() => log.getTerm(4), TypeError)
})

test('getEntry() returns the entry at the given index', t => {
  const { log } = t.context
  const entry = new Entry(1, 1, Symbol())
  log.replace([entry])
  t.true(log.getEntry(1) === entry)
})

test('getEntry() returns undefined if no entry exists at the given index', t => {
  const { log } = t.context
  t.true(log.getEntry(1) === undefined)
})

preseeded.test('getEntriesSince() returns all entries in order, starting at the given index', t => {
  const { entries, log } = t.context
  const since = log.getEntriesSince(2)
  t.true(since.length === 2)
  t.true(since[0] === entries[1])
  t.true(since[1] === entries[2])
})

test('appendValue() persists an entry for the value', t => {
  const { log, persistEntries } = t.context
  const value = Symbol()
  log.appendValue(1, value)

  t.true(persistEntries.calledOnce)
  const { args: [[entry]] } = persistEntries.firstCall
  t.true(entry.value === value)
})

preseeded.test('appendValue() increments the index for the new entry compared to the last entry', t => {
  const { entries, log, persistEntries } = t.context
  const [, , last] = entries
  log.appendValue(1, Symbol())
  const { args: [[entry]] } = persistEntries.firstCall
  t.true(entry.index === last.index + 1)
})

test('appendValue() persists an entry with the given term', t => {
  const { log, persistEntries } = t.context
  log.appendValue(2, Symbol())
  const { args: [[entry]] } = persistEntries.firstCall
  t.true(entry.term === 2)
})

persistingAppend.test('appendValue() sets lastIndex once the entry is persisted', async t => {
  const { finish, log } = t.context
  t.true(log.lastIndex === 0)
  await finish()
  t.true(log.lastIndex === 1)
})

persistingAppend.test('appendValue() sets lastTerm once the entry is persisted', async t => {
  const { finish, log } = t.context
  t.true(log.lastTerm === 0)
  await finish()
  t.true(log.lastTerm === 1)
})

persistingAppend.test('appendValue() adds the new entry once it is persisted', async t => {
  const { entry, finish, log } = t.context
  t.true(log.getEntry(1) === undefined)
  await finish()
  t.true(log.getEntry(1) === entry)
})

persistingAppend.test('appendValue() returns a promise that is fulfilled with the new entry, once it is persisted', async t => {
  const { entry, finish } = t.context
  t.true(await finish() === entry)
})

test('mergeEntries() persists the entries', t => {
  const { log, persistEntries } = t.context
  const entries = makeEntries(1, 1, 3)
  log.mergeEntries(entries)

  const { args: [persisting] } = persistEntries.firstCall
  t.true(persisting.length === 3)
  t.true(persisting[0] === entries[0])
  t.true(persisting[1] === entries[1])
  t.true(persisting[2] === entries[2])
})

preseeded.test('mergeEntries() does not persist duplicate entries', t => {
  const { entries, log, persistEntries } = t.context
  const extra = new Entry(4, 1, Symbol())
  log.mergeEntries(entries.slice(1).concat(extra))

  const { args: [persisting] } = persistEntries.firstCall
  t.true(persisting.length === 1)
  t.true(persisting[0] === extra)
})

preseeded.test('mergeEntries() is a no-op if there are no new entries to be merged', async t => {
  const { entries, log, persistEntries } = t.context
  const promise = log.mergeEntries(entries)
  t.true(persistEntries.notCalled)
  t.truthy(promise)
  t.true(await promise === undefined)
})

test('mergeEntries() adds each entry once it is persisted', async t => {
  const { log, resolvePersistEntries } = setupResolvePersistEntries(t.context)
  const entries = makeEntries(1, 1, 3)
  const promise = log.mergeEntries(entries)
  t.true(log.getEntry(1) === undefined)

  resolvePersistEntries()
  await promise
  for (const entry of entries) {
    t.true(log.getEntry(entry.index) === entry)
  }
})

preseeded.test('mergeEntries() deletes earlier conflicting entries', async t => {
  const { entries, log, resolvePersistEntries } = setupResolvePersistEntries(t.context)
  const newEntries = makeEntries(2, 2, 3)
  const promise = log.mergeEntries(newEntries)
  t.true(log.getEntry(2) === entries[1])

  resolvePersistEntries()
  await promise

  t.true(log.getEntry(1) === entries[0])
  for (const entry of newEntries) {
    t.true(log.getEntry(entry.index) === entry)
  }
})

test('mergeEntries() sets lastIndex once all entries are persisted', async t => {
  const { log, resolvePersistEntries } = setupResolvePersistEntries(t.context)
  const entries = makeEntries(1, 1, 3)
  const [, , last] = entries
  const promise = log.mergeEntries(entries)
  t.true(log.lastIndex === 0)

  resolvePersistEntries()
  await promise

  t.true(log.lastIndex === last.index)
})

test('mergeEntries() sets lastTerm once all entries are persisted', async t => {
  const { log, resolvePersistEntries } = setupResolvePersistEntries(t.context)
  const entries = makeEntries(1, 1, 2).concat(new Entry(3, 2, Symbol()))
  const [, , last] = entries
  const promise = log.mergeEntries(entries)
  t.true(log.lastTerm === 0)

  resolvePersistEntries()
  await promise

  t.true(log.lastTerm === last.term)
})

test('commit() invokes enqueue() on the applier, with the entry at the given index', async t => {
  const { applier, log } = t.context
  const entry = await log.appendValue(1, Symbol())
  log.commit(entry.index)

  t.true(applier.enqueue.calledOnce)
  const { args: [enqueued, resolve] } = applier.enqueue.firstCall
  t.true(enqueued === entry)
  t.true(typeof resolve === 'function')
})

preseeded.test('commit() enqueues earlier, uncommitted entries up to and including the one at the given index, in order', async t => {
  const { applier, entries, log } = t.context
  const latest = await log.appendValue(1, Symbol())
  applier._lastQueued.returns(1)
  log.commit(latest.index)

  t.true(applier.enqueue.calledThrice)
  for (let n = 0; n < 3; n++) {
    const { args: [entry, resolve] } = applier.enqueue.getCall(n)
    if (n === 0) {
      t.true(entry === entries[1])
    } else if (n === 1) {
      t.true(entry === entries[2])
    } else {
      t.true(entry === latest)
    }

    if (n < 2) {
      t.true(resolve === undefined)
    } else {
      t.true(typeof resolve === 'function')
    }
  }
})

test('commit() returns a promise that is fulfilled with the result of committing the entry at the given index', async t => {
  const { applier, log } = t.context
  const entry = await log.appendValue(1, Symbol())
  const p = log.commit(entry.index)

  const { args: [, resolve] } = applier.enqueue.firstCall
  const result = Symbol()
  resolve(result)
  t.true(await p === result)
})
