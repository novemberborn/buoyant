import { beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import { stub } from 'sinon'

import { getReason } from './support/utils'

import State from '🏠/lib/State'

describe('State', () => {
  beforeEach(ctx => {
    ctx.persist = stub().returns(Promise.resolve())
    ctx.state = new State(ctx.persist)
  })

  const testPersistence = setup => {
    it('persists the currentTerm and votedFor values', ctx => {
      const { currentTerm, votedFor } = setup(ctx)
      const { args: [{ currentTerm: persistedTerm, votedFor: persistedVote }] } = ctx.persist.firstCall
      assert(currentTerm === persistedTerm)
      assert(votedFor === persistedVote)
    })

    it('returns a promise for when it’s persisted the state', ctx => {
      assert(setup(ctx).promise instanceof Promise)
    })

    context('persisting the state succeeds', () => {
      it('fulfills the promise', async ctx => {
        ctx.persist.returns(Promise.resolve(Symbol()))
        assert(await setup(ctx).promise === undefined)
      })
    })

    context('persisting the state fails', () => {
      it('rejects the promise', async ctx => {
        const err = Symbol()
        ctx.persist.returns(Promise.reject(err))
        assert(await getReason(setup(ctx).promise) === err)
      })
    })
  }

  describe('constructor (persist)', () => {
    it('initializes currentTerm to 0', ctx => {
      assert(ctx.state.currentTerm === 0)
    })

    it('initializes votedFor to null', ctx => {
      assert(ctx.state.votedFor === null)
    })
  })

  describe('#replace ({ currentTerm, votedFor })', () => {
    ;[
      { desc: 'not an integer', value: '🙊' },
      { desc: 'not a safe integer', value: Number.MAX_SAFE_INTEGER + 1 },
      { desc: 'lower than 0', value: -1 }
    ].forEach(({ desc, value }) => {
      context(`currentTerm is ${desc}`, () => {
        it('throws a TypeError', ctx => {
          assert.throws(
            () => ctx.state.replace({ currentTerm: value, votedFor: null }),
            TypeError,
            'Cannot replace state: current term must be a safe, non-negative integer')
        })
      })
    })

    it('sets currentTerm to the currentTerm value', ctx => {
      ctx.state.replace({ currentTerm: 1 })
      assert(ctx.state.currentTerm === 1)
    })

    it('sets votedFor to the votedFor value', ctx => {
      const votedFor = Symbol()
      ctx.state.replace({ currentTerm: 1, votedFor })
      assert(ctx.state.votedFor === votedFor)
    })
  })

  describe('#nextTerm (votedFor = null)', () => {
    context('currentTerm is the max safe integer', () => {
      it('throws a RangeError', ctx => {
        ctx.state.replace({ currentTerm: Number.MAX_SAFE_INTEGER })
        assert.throws(
          () => ctx.state.nextTerm(),
          RangeError,
          'Cannot advance term: it is already the maximum safe integer value')
      })
    })

    it('increments currentTerm', ctx => {
      ctx.state.nextTerm()
      assert(ctx.state.currentTerm === 1)
    })

    it('sets votedFor to the votedFor value', ctx => {
      const votedFor = Symbol()
      ctx.state.nextTerm(votedFor)
      assert(ctx.state.votedFor === votedFor)
    })

    testPersistence(ctx => {
      const votedFor = Symbol()
      return {
        promise: ctx.state.nextTerm(votedFor),
        currentTerm: 1,
        votedFor
      }
    })
  })

  const testTermValue = method => {
    ;[
      { desc: 'not an integer', value: '🙊' },
      { desc: 'not a safe integer', value: Number.MAX_SAFE_INTEGER + 1 },
      { desc: 'lower than 1', value: 0 }
    ].forEach(({ desc, value }) => {
      context(`term is ${desc}`, () => {
        it('throws a TypeError', ctx => {
          assert.throws(
            () => ctx.state[method](value),
            TypeError,
            'Cannot set term: must be a safe integer, greater than or equal to 1')
        })
      })
    })
  }

  describe('#setTerm (term)', () => {
    testTermValue('setTerm')

    it('sets currentTerm to the term value', ctx => {
      ctx.state.setTerm(42)
      assert(ctx.state.currentTerm === 42)
    })

    it('sets votedFor to null', ctx => {
      ctx.state.replace({ currentTerm: 1, votedFor: Symbol() })
      ctx.state.setTerm(42)
      assert(ctx.state.votedFor === null)
    })

    testPersistence(ctx => {
      return {
        promise: ctx.state.setTerm(42),
        currentTerm: 42,
        votedFor: null
      }
    })
  })

  describe('#setTermAndVote (term, votedFor)', () => {
    testTermValue('setTermAndVote')

    it('sets currentTerm to the term value', ctx => {
      ctx.state.setTermAndVote(42, Symbol())
      assert(ctx.state.currentTerm === 42)
    })

    it('sets votedFor to the votedFor value', ctx => {
      const votedFor = Symbol()
      ctx.state.setTermAndVote(42, votedFor)
      assert(ctx.state.votedFor === votedFor)
    })

    testPersistence(ctx => {
      const votedFor = Symbol()
      return {
        promise: ctx.state.setTermAndVote(42, votedFor),
        currentTerm: 42,
        votedFor
      }
    })
  })
})
