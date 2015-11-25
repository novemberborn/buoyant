import { before, context, describe, it } from '!mocha'
import assert from 'power-assert'

import Entry from '../lib/Entry'

describe('Entry', () => {
  describe('constructor (index, term, value)', () => {
    ;[
      { desc: 'index is not an integer', values: ['🙊', 1], message: "Parameter 'index' must be a safe integer, greater or equal than 1" },
      { desc: 'index is not a safe integer', values: [Number.MAX_SAFE_INTEGER + 1, 1], message: "Parameter 'index' must be a safe integer, greater or equal than 1" },
      { desc: 'index is lower than 1', values: [0, 1], message: "Parameter 'index' must be a safe integer, greater or equal than 1" },
      { desc: 'term is an integer', values: [1, '🙊'], message: "Parameter 'term' must be a safe integer, greater or equal than 1" },
      { desc: 'term is not a safe integer', values: [1, Number.MAX_SAFE_INTEGER + 1], message: "Parameter 'term' must be a safe integer, greater or equal than 1" },
      { desc: 'term is lower than 1', values: [1, 0], message: "Parameter 'term' must be a safe integer, greater or equal than 1" }
    ].forEach(({ desc, values, message }) => {
      context(desc, () => {
        it('throws a TypeError', () => {
          assert.throws(
            () => new Entry(...values),
            TypeError, message)
        })
      })
    })

    ;[
      { param: 'index', index: 0, value: 1 },
      { param: 'term', index: 1, value: 2 },
      { param: 'value', index: 2, value: Symbol() }
    ].forEach(({ param, index, value }) => {
      it(`sets ${param} on the instance to the corresponding value`, () => {
        const args = [1, 1, '🙊']
        args[index] = value
        assert(new Entry(...args)[param] === value)
      })
    })
  })

  ;['index', 'term', 'value'].forEach(field => {
    describe(`#${field}`, () => {
      before(ctx => {
        const entry = new Entry(1, 1, '🙊')
        ctx.descriptor = Object.getOwnPropertyDescriptor(entry, field)
      })

      it('is not writable', ctx => {
        assert(!ctx.descriptor.writable)
      })

      it('is not configurable', ctx => {
        assert(!ctx.descriptor.configurable)
      })

      it('is enumerable', ctx => {
        assert(ctx.descriptor.enumerable)
      })
    })
  })
})
