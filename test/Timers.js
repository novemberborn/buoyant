import { after, before, beforeEach, describe, it } from '!mocha'
import assert from 'power-assert'
import { install as installClock } from 'lolex'
import { spy } from 'sinon'

import Timers from '../lib/Timers'

describe('Timers', () => {
  before(ctx => {
    ctx.clock = installClock(0, ['clearInterval', 'setInterval', 'clearTimeout', 'setTimeout'])
  })
  after(ctx => ctx.clock.uninstall())

  beforeEach(ctx => {
    ctx.timers = new Timers()
    ctx.spy = spy()
  })

  describe('#clearInterval (intervalObject)', () => {
    it('clears the interval', ctx => {
      const obj = ctx.timers.setInterval(ctx.spy, 100)
      ctx.timers.clearInterval(obj)

      ctx.clock.tick(100)
      assert(ctx.spy.notCalled)
    })
  })

  describe('#setInterval (callback, delay, ...args)', () => {
    it('sets the interval', ctx => {
      const args = [Symbol(), Symbol()]
      ctx.timers.setInterval(ctx.spy, 100, ...args)

      ctx.clock.tick(100)
      ctx.clock.tick(100)
      assert(ctx.spy.calledTwice)
      const { args: [firstArgs, secondArgs] } = ctx.spy
      assert.deepStrictEqual(firstArgs, args)
      assert.deepStrictEqual(secondArgs, args)
    })
  })

  describe('#clearTimeout (timeoutObject)', () => {
    it('clears the timeout', ctx => {
      const obj = ctx.timers.setTimeout(ctx.spy, 100)
      ctx.timers.clearTimeout(obj)

      ctx.clock.tick(100)
      assert(ctx.spy.notCalled)
    })
  })

  describe('#setTimeout (callback, delay, ...args)', () => {
    it('sets the timeout', ctx => {
      const args = [Symbol(), Symbol()]
      ctx.timers.setTimeout(ctx.spy, 100, ...args)

      ctx.clock.tick(100)
      ctx.clock.tick(100)
      assert(ctx.spy.calledOnce)
      const { args: [firstArgs] } = ctx.spy
      assert.deepStrictEqual(firstArgs, args)
    })
  })
})
