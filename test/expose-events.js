import { before, beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import proxyquire from 'proxyquire'
import { spy, stub } from 'sinon'

describe('expose-events', () => {
  before(ctx => {
    ctx.process = stub({ nextTick () {} })
    ctx.exposeEvents = proxyquire.noCallThru()('../lib/expose-events', {
      './process': ctx.process
    })['default']
  })

  beforeEach(ctx => {
    ctx.process.nextTick.reset()
  })

  describe('exposeEvents (target)', () => {
    it('correctly defines on, once and removeListener on target', ctx => {
      const target = {}
      ctx.exposeEvents(target)

      for (const prop of ['on', 'once', 'removeListener']) {
        const { value, configurable, enumerable, writable } = Object.getOwnPropertyDescriptor(target, prop)
        assert(typeof value === 'function', prop)
        assert(configurable, prop)
        assert(!enumerable, prop)
        assert(writable, prop)
      }
    })

    it('returns an emitter', ctx => {
      const emitter = ctx.exposeEvents({})
      assert(typeof emitter.emit === 'function')
    })

    ;['on', 'once', 'removeListener'].forEach(method => {
      describe(`target.${method} (event, listener)`, ctx => {
        beforeEach(ctx => {
          ctx.target = {}
          ctx.emitter = ctx.exposeEvents(ctx.target)
          stub(ctx.emitter, method)
        })

        it('propagates the arguments to the emitter', ctx => {
          const args = [Symbol(), Symbol()]
          ctx.target[method](...args)

          assert(ctx.emitter[method].calledOnce)
          const { args: propagated } = ctx.emitter[method].firstCall
          assert.deepStrictEqual(propagated, args)
        })

        it('returns the thisArg', ctx => {
          const thisArg = Symbol()
          assert(ctx.target[method].call(thisArg) === thisArg)
        })
      })
    })
  })

  describe('the emitter returned by exposeEvents(target)', () => {
    const makeEmitter = ctx => {
      ctx.target = {}
      ctx.emitter = ctx.exposeEvents(ctx.target)
    }

    beforeEach(makeEmitter)

    ;['on', 'once'].forEach(method => {
      describe(`emitter.${method} (event, listener)`, () => {
        beforeEach(ctx => {
          ctx.event = Symbol
          ctx.listener = spy()
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
          ctx.emitter.emit(ctx.event)
          assert(ctx.listener.calledOnce)
        })

        describe('the listener', () => {
          it('is called with the target as the thisArg', ctx => {
            ctx.emitter.emit(ctx.event)
            const { thisValue: target } = ctx.listener.firstCall
            assert(target === ctx.target)
          })

          context('is registered more than once for the same event', () => {
            beforeEach(ctx => ctx.emitter[method](ctx.event, ctx.listener))

            it('is called once per emitted event', ctx => {
              ctx.emitter.emit(ctx.event)
              assert(ctx.listener.calledOnce)
            })
          })

          context('is registered for different events', () => {
            beforeEach(ctx => {
              ctx.event2 = Symbol()
              ctx.emitter[method](ctx.event2, ctx.listener)
            })

            it('is called for each event', ctx => {
              const [first, second] = [Symbol(), Symbol()]

              ctx.emitter.emit(ctx.event, first)
              ctx.emitter.emit(ctx.event2, second)

              const { args: [[firstValue], [secondValue]] } = ctx.listener
              assert(firstValue === first)
              assert(secondValue === second)
            })
          })
        })

        context('the event is emitted multiple times', () => {
          const eachTime = () => {
            describe('the listener', () => {
              it('is called each time', ctx => {
                [Symbol(), Symbol(), Symbol()].forEach((arg, n) => {
                  ctx.emitter.emit(ctx.event, arg)
                  assert(ctx.listener.callCount === n + 1)
                  const { args: [value] } = ctx.listener.getCall(n)
                  assert(value === arg)
                })
              })
            })
          }
          const oneTime = () => {
            describe('the listener', () => {
              it('is called only once', ctx => {
                const first = Symbol()
                ;[first, Symbol(), Symbol()].forEach((arg, n) => {
                  ctx.emitter.emit(ctx.event, arg)
                  assert(ctx.listener.calledOnce)
                  const { args: [value] } = ctx.listener.firstCall
                  assert(value === first)
                })
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
                const listener2 = spy()
                ctx.emitter.on(ctx.event, listener2)

                ctx.emitter.emit(ctx.event)
                assert(ctx.listener.calledBefore(listener2))
              })
            })
          })
        }
      })
    })

    describe('emitter.removeListener (event, listener)', () => {
      beforeEach(ctx => {
        ctx.event = Symbol
        ctx.listener = spy()
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

            ctx.emitter.emit(ctx.event)
            assert(ctx.listener.notCalled)
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
        it('is not removed', ctx => {
          const listener2 = spy()
          ctx.emitter.on(ctx.event, ctx.listener)
          ctx.emitter.on(ctx.event, listener2)
          ctx.emitter.removeListener(ctx.event, ctx.listener)

          ctx.emitter.emit(ctx.event)
          assert(ctx.listener.notCalled)
          assert(listener2.calledOnce)
        })
      })
    })

    describe('emitter.emit (event, ...params)', () => {
      beforeEach(ctx => {
        ctx.listener = spy()
      })

      it('calls listeners synchronously', ctx => {
        ctx.emitter.on(ctx.event, ctx.listener)

        ctx.emitter.emit(ctx.event)
        assert(ctx.listener.calledOnce)
      })

      context('listers are only added after emitting', () => {
        it('does not call them', ctx => {
          ctx.emitter.emit(ctx.event)
          ctx.emitter.on(ctx.event, ctx.listener)
          assert(ctx.listener.notCalled)
        })
      })

      context('listers are added while emitting', () => {
        it('calls them', ctx => {
          ctx.emitter.on(ctx.event, () => {
            ctx.emitter.on(ctx.event, ctx.listener)
          })

          ctx.emitter.emit(ctx.event)
          assert(ctx.listener.calledOnce)
        })
      })

      context('listers are removed while emitting', () => {
        it('does not call them', ctx => {
          ctx.emitter.on(ctx.event, () => {
            ctx.emitter.removeListener(ctx.event, ctx.listener)
          })
          ctx.emitter.on(ctx.event, ctx.listener)

          ctx.emitter.emit(ctx.event)
          assert(ctx.listener.notCalled)
        })
      })

      context('a listener throws', () => {
        beforeEach(ctx => {
          ctx.err = Symbol()
          ctx.emitter.on(ctx.event, () => { throw ctx.err })
          ctx.emitter.on(ctx.event, ctx.listener)
        })

        describe('the next listener', () => {
          it('is not called', ctx => {
            ctx.emitter.emit(ctx.event)
            assert(ctx.listener.notCalled)
          })
        })

        describe('the error', () => {
          it('is rethrown asynchronously', ctx => {
            ctx.emitter.emit(ctx.event)

            assert(ctx.process.nextTick.calledOnce)
            try {
              ctx.process.nextTick.yield()
              assert(false, 'nextTick should throw')
            } catch (err) {
              assert(err === ctx.err)
            }
          })
        })
      })

      it('calls the listeners with all params', ctx => {
        const params = [Symbol(), Symbol(), Symbol()]
        ctx.emitter.on(ctx.event, ctx.listener)

        ctx.emitter.emit(ctx.event, ...params)
        const { args: allParams } = ctx.listener.firstCall
        assert.deepStrictEqual(allParams, params)
      })
    })
  })
})
