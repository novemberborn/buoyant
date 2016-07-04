// https://github.com/avajs/eslint-plugin-ava/issues/127
/* eslint-disable ava/use-t */

// Macro detection goes wrong
/* eslint-disable ava/no-identical-title */

import test from 'ava'
import { stub } from 'sinon'

import State from 'dist/lib/State'

import macro from './helpers/macro'

// Don't use the Promise introduced by babel-runtime. https://github.com/avajs/ava/issues/947
const { Promise } = global

const throwsTypeError = macro((t, method, arg, message) => {
  const { state } = t.context
  t.throws(() => state[method](arg), TypeError, message)
}, (suffix, method) => `${method}() throws a TypeError if ${method === 'replace' ? 'currentTerm' : 'term'} is ${suffix}`)

const persistCurrentTermAndVoteFor = macro((t, currentTerm, votedFor, fn) => {
  const { persist, state } = t.context
  fn(state, votedFor)
  const { args: [{ currentTerm: persistedTerm, votedFor: persistedVote }] } = persist.firstCall
  t.true(currentTerm === persistedTerm)
  t.true(votedFor === persistedVote)
}, prefix => `${prefix} persists the currentTerm and votedFor values`)

const returnsPromiseForPersistence = macro((t, currentTerm, votedFor, fn) => {
  const { state } = t.context
  t.true(fn(state, votedFor) instanceof Promise)
}, prefix => `${prefix} returns a promise for when it’s persisted the state`)

const fulfilsPersistencePromise = macro(async (t, currentTerm, votedFor, fn) => {
  const { persist, state } = t.context
  persist.returns(Promise.resolve(Symbol()))
  t.true(await fn(state, votedFor) === undefined)
}, prefix => `${prefix} fulfils the returned promise once the state has persisted`)

const rejectsPersistencePromise = macro(async (t, currentTerm, votedFor, fn) => {
  const { persist, state } = t.context
  const err = new Error()
  persist.returns(Promise.reject(err))
  const actualErr = await t.throws(fn(state, votedFor))
  t.true(actualErr === err)
}, prefix => `${prefix} rejects the returned promise if persisting the state fails`)

test.beforeEach(t => {
  const persist = stub().returns(Promise.resolve())
  const state = new State(persist)

  Object.assign(t.context, { persist, state })
})

test('currentTerm is initialized to 0', t => {
  const { state } = t.context
  t.true(state.currentTerm === 0)
})

test('votedFor is initialized to null', t => {
  const { state } = t.context
  t.true(state.votedFor === null)
})

test('replace() sets currentTerm to the currentTerm value', t => {
  const { state } = t.context
  state.replace({ currentTerm: 1 })
  t.true(state.currentTerm === 1)
})

test('replace() sets votedFor to the votedFor value', t => {
  const { state } = t.context
  const votedFor = Symbol()
  state.replace({ currentTerm: 1, votedFor })
  t.true(state.votedFor === votedFor)
})

test('nextTerm() throws a RangeError if currentTerm is already the max safe integer', t => {
  const { state } = t.context
  state.replace({ currentTerm: Number.MAX_SAFE_INTEGER })
  t.throws(
    () => state.nextTerm(),
    RangeError,
    'Cannot advance term: it is already the maximum safe integer value'
  )
})

test('nextTerm() increments currentTerm', t => {
  const { state } = t.context
  state.nextTerm()
  t.true(state.currentTerm === 1)
})

test('nextTerm() sets votedFor to the votedFor value', t => {
  const { state } = t.context
  const votedFor = Symbol()
  state.nextTerm(votedFor)
  t.true(state.votedFor === votedFor)
})

test('setTerm() sets currentTerm to the term value', t => {
  const { state } = t.context
  state.setTerm(42)
  t.true(state.currentTerm === 42)
})

test('setTerm() sets votedFor to null', t => {
  const { state } = t.context
  state.replace({ currentTerm: 1, votedFor: Symbol() })
  state.setTerm(42)
  t.true(state.votedFor === null)
})

test('setTermAndVote() sets currentTerm to the term value', t => {
  const { state } = t.context
  state.setTermAndVote(42, Symbol())
  t.true(state.currentTerm === 42)
})

test('setTermAndVote() sets votedFor to the votedFor value', t => {
  const { state } = t.context
  const votedFor = Symbol()
  state.setTermAndVote(42, votedFor)
  t.true(state.votedFor === votedFor)
})

for (const [suffix, value] of [
  ['not an integer', '🙊'],
  ['not a safe integer', Number.MAX_SAFE_INTEGER + 1],
  ['lower than 0', -1]
]) {
  test(suffix, throwsTypeError, 'replace', { currentTerm: value, votedFor: null }, 'Cannot replace state: current term must be a safe, non-negative integer')
  test(suffix, throwsTypeError, 'setTerm', value, 'Cannot set term: current term must be a safe, non-negative integer')
  test(suffix, throwsTypeError, 'setTermAndVote', value, 'Cannot set term: current term must be a safe, non-negative integer')
}

for (const macro of [
  persistCurrentTermAndVoteFor,
  returnsPromiseForPersistence,
  fulfilsPersistencePromise,
  rejectsPersistencePromise
]) {
  test('nextTerm()', macro, 1, Symbol(), (state, votedFor) => state.nextTerm(votedFor))
  test('setTerm()', macro, 42, null, state => state.setTerm(42))
  test('setTermAndVote()', macro, 42, Symbol(), (state, votedFor) => state.setTermAndVote(42, votedFor))
}
