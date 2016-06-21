// https://github.com/avajs/eslint-plugin-ava/issues/127
/* eslint-disable ava/use-t */

import test from 'ava'
import { spy, stub } from 'sinon'

import Scheduler from '../lib/Scheduler'

import macro from './helpers/macro'

// Don't use the Promise introduced by babel-runtime. https://github.com/avajs/ava/issues/947
const { Promise } = global

const asapReturnsPending = macro(async (t, fn, setup = () => {}) => {
  const { scheduler } = t.context
  setup(t.context)

  const expected = Symbol()
  const soon = new Promise(resolve => setImmediate(() => resolve(expected)))
  t.true(await Promise.race([scheduler.asap(null, fn), soon]) === expected)
}, suffix => `asap() returns a perpetually pending promise ${suffix}`)

const asapInvokesCrashHandler = macro(async (t, crashingFn) => {
  const { crashHandler, scheduler } = t.context
  const err = Symbol()
  scheduler.asap(null, () => crashingFn(err))

  await new Promise(resolve => setImmediate(resolve))
  t.true(crashHandler.calledOnce)
  const { args: [reason] } = crashHandler.firstCall
  t.true(reason === err)
}, suffix => `asap() invokes the crashHandler ${suffix}`)

test.beforeEach(t => {
  const crashHandler = stub()
  const scheduler = new Scheduler(crashHandler)

  Object.assign(t.context, { crashHandler, scheduler })
})

test('asap() calls handleAbort when invoked after the scheduler is aborted', t => {
  const { scheduler } = t.context
  scheduler.abort()
  const handleAbort = spy()
  scheduler.asap(handleAbort)
  t.true(handleAbort.calledOnce)
})

test('when invoked after the scheduler is aborted', asapReturnsPending, () => {}, ({ scheduler }) => scheduler.abort())

test('asap() synchronously calls fn if no other operation is currently active', t => {
  const { scheduler } = t.context
  const fn = spy()
  scheduler.asap(null, fn)

  t.true(fn.calledOnce)
})

test('with the error if fn throws', asapInvokesCrashHandler, err => { throw err })

test('if fn throws', asapReturnsPending, () => { throw new Error() })

test('asap() returns undefined if fn doesn’t return a promise', t => {
  const { scheduler } = t.context
  t.true(scheduler.asap(null, () => {}) === undefined)
})

test('asap() returns a promise if fn returns a promise', t => {
  const { scheduler } = t.context
  t.true(scheduler.asap(null, () => new Promise(() => {})) instanceof Promise)
})

test('asap() fulfils its promise with undefined once the fn-returned promise fulfils', async t => {
  const { scheduler } = t.context
  t.true(await scheduler.asap(null, () => Promise.resolve(Symbol())) === undefined)
})

test('with the rejection reason if the fn-returned promise rejects', asapInvokesCrashHandler, err => Promise.reject(err))
test('if the fn-returned promise rejects', asapReturnsPending, () => Promise.reject(new Error()))

test('asap() prevents two operations from being run at the same time', t => {
  const { scheduler } = t.context
  scheduler.asap(null, () => new Promise(() => {}))
  const second = spy()
  scheduler.asap(null, second)

  t.true(second.notCalled)
})

test('asap() returns a promise for when the second operation has finished', t => {
  const { scheduler } = t.context
  scheduler.asap(null, () => new Promise(() => {}))
  const p = scheduler.asap(null, () => {})
  t.true(p instanceof Promise)
})

test('asap() runs scheduled operations in order', async t => {
  const { scheduler } = t.context
  scheduler.asap(null, () => Promise.resolve())
  const second = spy()
  scheduler.asap(null, second)
  const third = spy()
  await scheduler.asap(null, third)

  t.true(second.calledBefore(third))
})

test('abort() stops any remaining operations from being run', async t => {
  const { scheduler } = t.context
  const first = scheduler.asap(null, () => Promise.resolve())
  const second = spy()
  scheduler.asap(null, second)

  scheduler.abort()
  await first
  t.true(second.notCalled)
})

test('abort() invokes the handleAbort callbacks of any remaining operations', t => {
  const { scheduler } = t.context
  const first = spy()
  scheduler.asap(first, () => Promise.resolve())
  const second = spy()
  scheduler.asap(second, () => {})
  const third = spy()
  scheduler.asap(third, () => {})

  scheduler.abort()
  t.true(first.notCalled)
  t.true(second.calledBefore(third))
})
