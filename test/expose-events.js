import { beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import sinon from 'sinon'

import exposeEvents from '../lib/expose-events'

describe('expose-events', () => {
  describe('exposeEvents (target)', () => {
    it('correctly defines on, once and removeListener on target', () => {
      const target = {}
      exposeEvents(target)

      for (const prop of ['on', 'once', 'removeListener']) {
        const { value, configurable, enumerable, writable } = Object.getOwnPropertyDescriptor(target, prop)
        assert(typeof value === 'function', prop)
        assert(configurable, prop)
        assert(!enumerable, prop)
        assert(writable, prop)
      }
    })

    it('returns an emitter', () => {
      const emitter = exposeEvents({})
      assert(typeof emitter.emit === 'function')
    })

    ;['on', 'once', 'removeListener'].forEach(method => {
      describe(`target.${method} (event, listener)`, () => {
        beforeEach(ctx => {
          ctx.target = {}
          ctx.emitter = exposeEvents(ctx.target)
          sinon.stub(ctx.emitter, method)
        })

        it('propagates the arguments to the emitter', ctx => {
          const args = [Symbol(), Symbol()]
          ctx.target[method](...args)

          sinon.assert.calledOnce(ctx.emitter[method])
          sinon.assert.calledWithExactly(ctx.emitter[method], ...args)
        })

        it('returns the thisArg', ctx => {
          const thisArg = Symbol()
          assert(ctx.target[method].call(thisArg) === thisArg)
        })
      })
    })
  })

  describe('the emitter returned by exposeEvents(target)', () => {
    let emit

    const makeEmitter = ctx => {
      ctx.target = {}
      ctx.emitter = exposeEvents(ctx.target)
      emit = (event, ...params) => {
        return new Promise(resolve => {
          ctx.emitter.emit(event, ...params)
          process.nextTick(resolve)
        })
      }
    }

    beforeEach(makeEmitter)

    ;['on', 'once'].forEach(method => {
      describe(`emitter.${method} (event, listener)`, () => {
        beforeEach(ctx => {
          ctx.event = Symbol
          ctx.listener = sinon.spy()
          ctx.emitter[method](ctx.event, ctx.listener)
        })

        context('listener is not a function', () => {
          it('throws a TypeError', ctx => {
            assert.throws(
              () => ctx.emitter[method](ctx.event),
              TypeError, "Parameter 'listener' must be a function, not undefined")
          })
        })

        it('registers the listener for the event', ctx => {
          return emit(ctx.event).then(() => {
            sinon.assert.calledOnce(ctx.listener)
          })
        })

        describe('the listener', () => {
          it('is called with the target as the thisArg', ctx => {
            return emit(ctx.event).then(() => {
              sinon.assert.calledOn(ctx.listener, ctx.target)
            })
          })

          context('is registered more than once for the same event', () => {
            beforeEach(ctx => ctx.emitter[method](ctx.event, ctx.listener))

            it('is called once per emitted event', ctx => {
              return emit(ctx.event).then(() => {
                sinon.assert.calledOnce(ctx.listener)
              })
            })
          })

          context('is registered for different events', () => {
            beforeEach(ctx => {
              ctx.event2 = Symbol()
              ctx.emitter[method](ctx.event2, ctx.listener)
            })

            it('is called for each event', ctx => {
              const [first, second] = [Symbol(), Symbol()]
              return emit(ctx.event, first).then(() => {
                sinon.assert.calledWithExactly(ctx.listener, first)
                return emit(ctx.event2, second)
              }).then(() => {
                sinon.assert.calledWithExactly(ctx.listener, second)
              })
            })
          })
        })

        context('the event is emitted multiple times', () => {
          const eachTime = () => {
            describe('the listener', () => {
              it('is called each time', ctx => {
                return [Symbol(), Symbol(), Symbol()].reduce((prev, arg, n) => {
                  return prev.then(() => emit(ctx.event, arg)).then(() => {
                    assert(ctx.listener.callCount === n + 1)
                    assert(ctx.listener.getCall(n).calledWithExactly(arg))
                  })
                }, Promise.resolve())
              })
            })
          }
          const oneTime = () => {
            describe('the listener', () => {
              it('is called only once', ctx => {
                const first = Symbol()
                return [first, Symbol(), Symbol()].reduce((prev, arg, n) => {
                  return prev.then(() => emit(ctx.event, arg)).then(() => {
                    sinon.assert.calledOnce(ctx.listener)
                    sinon.assert.calledWithExactly(ctx.listener, first)
                  })
                }, Promise.resolve())
              })
            })
          }

          if (method === 'on') {
            eachTime()
          } else {
            oneTime()
          }

          context(`the listener was previously registered for the same event using emitter.${method === 'on' ? 'once' : 'on'}()`, () => {
            beforeEach(ctx => {
              makeEmitter(ctx)
              if (method === 'on') {
                ctx.emitter.once(ctx.event, ctx.listener)
              } else {
                ctx.emitter.on(ctx.event, ctx.listener)
              }
              ctx.emitter[method](ctx.event, ctx.listener)
            })

            eachTime()
          })
        })

        if (method === 'once') {
          context('another listener was registered after the once listener', () => {
            describe('the second listener', () => {
              it('is called after the first', ctx => {
                const listener2 = sinon.spy()
                ctx.emitter.on(ctx.event, listener2)

                return emit(ctx.event).then(() => {
                  sinon.assert.callOrder(ctx.listener, listener2)
                })
              })
            })
          })
        }
      })
    })

    describe(`emitter.removeListener (event, listener)`, () => {
      beforeEach(ctx => {
        ctx.event = Symbol
        ctx.listener = sinon.spy()
      })

      context('listener is not a function', () => {
        it('throws a TypeError', ctx => {
          assert.throws(
            () => ctx.emitter.removeListener(ctx.event),
            TypeError, "Parameter 'listener' must be a function, not undefined")
        })
      })

      ;['on', 'once'].forEach(method => {
        context(`the listener was previously registered using emitter.${method}(event, listener)`, () => {
          it('is removed', ctx => {
            ctx.emitter[method](ctx.event, ctx.listener)

            ctx.emitter.removeListener(ctx.event, ctx.listener)
            return emit(ctx.event).then(() => {
              sinon.assert.notCalled(ctx.listener)
            })
          })
        })
      })

      // Test added for code coverage completeness.
      context('the listener was not registered previously', () => {
        it('is OK', ctx => {
          assert.doesNotThrow(() => ctx.emitter.removeListener(ctx.event, ctx.listener))
        })
      })

      // Test added for code coverage completeness.
      context('another listener was also registered for the same event', () => {
        it('is not removed', async ctx => {
          const listener2 = sinon.spy()
          ctx.emitter.on(ctx.event, ctx.listener)
          ctx.emitter.on(ctx.event, listener2)

          ctx.emitter.removeListener(ctx.event, ctx.listener)
          await emit(ctx.event)
          sinon.assert.notCalled(ctx.listener)
          sinon.assert.calledOnce(listener2)
        })
      })
    })

    describe(`emitter.emit (event, ...params)`, () => {
      beforeEach(ctx => ctx.listener = sinon.spy())

      it('starts calling listeners asynchronously', async ctx => {
        ctx.emitter.on(ctx.event, ctx.listener)

        ctx.emitter.emit(ctx.event)
        sinon.assert.notCalled(ctx.listener)

        // The emit(...params) helper already does this. nextTick is shown here
        // for clarity.
        await new Promise(resolve => process.nextTick(resolve))
        sinon.assert.calledOnce(ctx.listener)
      })

      context('listers are only added after emitting (but synchronously)', () => {
        it('does not call them', async ctx => {
          const p = emit()

          ctx.emitter.on(ctx.event, ctx.listener)

          await p
          sinon.assert.notCalled(ctx.listener)
        })
      })

      it('calls the listeners with all params', async ctx => {
        const params = [Symbol(), Symbol(), Symbol()]
        ctx.emitter.on(ctx.event, ctx.listener)

        await emit(ctx.event, ...params)
        sinon.assert.calledWithExactly(ctx.listener, ...params)
      })
    })
  })
})
