import test from 'ava'
import { install as installClock } from 'lolex'
import { spy } from 'sinon'
import Timers from '../lib/Timers'

const clock = installClock(0, ['clearInterval', 'setInterval', 'clearTimeout', 'setTimeout'])

function setup () {
  return [new Timers(), spy()]
}

test('clearInterval (intervalObject)', t => {
  const [timers, spy] = setup()
  const obj = timers.setInterval(spy, 100)
  timers.clearInterval(obj)
  clock.tick(100)

  t.true(spy.notCalled)
})

test('setInterval (callback, delay, ...args)', t => {
  const [timers, spy] = setup()
  const args = [Symbol(), Symbol()]
  timers.setInterval(spy, 100, ...args)
  clock.tick(100)
  clock.tick(100)

  t.true(spy.calledTwice)
  const { args: [firstArgs, secondArgs] } = spy
  t.deepEqual(firstArgs, args)
  t.deepEqual(secondArgs, args)
})

test('clearTimeout (timeoutObject)', t => {
  const [timers, spy] = setup()
  const obj = timers.setTimeout(spy, 100)
  timers.clearTimeout(obj)
  clock.tick(100)

  t.true(spy.notCalled)
})

test('setTimeout (callback, delay, ...args)', t => {
  const [timers, spy] = setup()
  const args = [Symbol(), Symbol()]
  timers.setTimeout(spy, 100, ...args)
  clock.tick(100)
  clock.tick(100)

  t.true(spy.calledOnce)
  const { args: [firstArgs] } = spy
  t.deepEqual(firstArgs, args)
})
