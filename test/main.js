import { before, beforeEach, describe, context, it } from '!mocha'
import assert from 'power-assert'
import proxyquire from 'proxyquire'
import { spy, stub } from 'sinon'

import { getReason } from './support/utils'

import {
  AppendEntries, AcceptEntries, RejectEntries,
  RequestVote, DenyVote, GrantVote,
  Noop
} from '../lib/symbols'
import Address from '../lib/Address'
import Entry from '../lib/Entry'

describe('main', () => {
  before(ctx => {
    ctx.Server = spy(() => stub())
    ctx.main = proxyquire.noCallThru()('../main', {
      './lib/Server': function (...args) { return ctx.Server(...args) }
    })
  })

  beforeEach(ctx => ctx.Server.reset())

  it('exports symbols', ctx => {
    assert.deepStrictEqual(ctx.main.symbols, {
      AppendEntries, AcceptEntries, RejectEntries,
      RequestVote, DenyVote, GrantVote,
      Noop
    })
  })

  it('exports Address', ctx => {
    assert(ctx.main.Address === Address)
  })

  it('exports Entry', ctx => {
    assert(ctx.main.Entry === Entry)
  })

  describe('createServer ({ address, electionTimeoutWindow, heartbeatInterval, createTransport, persistState, persistEntries, applyEntry, crashHandler })', () => {
    before(ctx => {
      ctx.createServer = opts => {
        return ctx.main.createServer(Object.assign({
          address: '///id',
          electionTimeoutWindow: [1000, 2000],
          heartbeatInterval: 500,
          createTransport () {},
          persistState () {},
          persistEntries () {},
          applyEntry () {},
          crashHandler () {}
        }, opts))
      }
    })

    const param = (name, def = () => {}) => {
      describe(`the ${name} parameter`, def)
    }

    param('address', () => {
      context('it is a string', () => {
        context('it is a valid address', () => {
          it('creates the server with an Address instance for that string', ctx => {
            ctx.createServer({ address: '///foo' })
            assert(ctx.Server.calledOnce)
            const { args: [{ address }] } = ctx.Server.firstCall
            assert(address instanceof Address)
            assert(address.serverId === 'foo')
          })
        })

        context('it is invalid', () => {
          it('causes a TypeError to be thrown', ctx => {
            assert.throws(
              () => ctx.createServer({ address: '🙈' }),
              TypeError,
              "Parameter 'address' must be a string or an Address instance")
          })
        })
      })

      context('it is an Address instance', () => {
        it('creates the server with the address, as-is', ctx => {
          const address = new Address('///foo')
          ctx.createServer({ address })
          assert(ctx.Server.calledOnce)
          const { args: [{ address: asIs }] } = ctx.Server.firstCall
          assert(asIs === address)
        })
      })

      context('it is not a string or an Address instance', () => {
        it('causes a TypeError to be thrown', ctx => {
          assert.throws(
            () => ctx.createServer({ address: 42 }),
            TypeError,
            "Parameter 'address' must be a string or an Address instance")
        })
      })

      context('the server is created', () => {
        describe('the serverId of the address', () => {
          it('is used as the server‘s id', ctx => {
            const address = new Address('///foo')
            ctx.createServer({ address })
            assert(ctx.Server.calledOnce)
            const { args: [{ id }] } = ctx.Server.firstCall
            assert(id === address.serverId)
          })
        })
      })
    })

    param('electionTimeoutWindow', () => {
      context('it is not iterable', () => {
        it('causes a TypeError to be thrown', ctx => {
          assert.throws(
            () => ctx.createServer({ electionTimeoutWindow: true }),
            TypeError,
            "Parameter 'electionTimeoutWindow' must be iterable")
        })
      })

      describe('the first value', () => {
        ;[
          { desc: 'not an integer', value: '🙈', message: "Values of parameter 'electionTimeoutWindow' must be integers" },
          { desc: 'less than zero', value: -1, message: "First value of parameter 'electionTimeoutWindow' must be greater than zero" },
          { desc: '0', value: 0, message: "First value of parameter 'electionTimeoutWindow' must be greater than zero" },
          { desc: 'larger than the second value', value: 11, message: "Second value of parameter 'electionTimeoutWindow' must be greater than the first" },
          { desc: 'equal to the second value', value: 10, message: "Second value of parameter 'electionTimeoutWindow' must be greater than the first" }
        ].forEach(({ desc, value, message }) => {
          context(`it is ${desc}`, () => {
            it('causes a TypeError to be thrown', ctx => {
              assert.throws(
                () => ctx.createServer({ electionTimeoutWindow: [value, 10] }),
                TypeError,
                message)
            })
          })
        })
      })

      describe('the second value', () => {
        context('is not an integer', () => {
          it('causes a TypeError to be thrown', ctx => {
            assert.throws(
              () => ctx.createServer({ electionTimeoutWindow: [10, '🙈'] }),
              TypeError,
              "Values of parameter 'electionTimeoutWindow' must be integers")
          })
        })

        // No need to check against 0 or the first value, the tests for the
        // first value will catch any errors.
      })

      context('the values are valid', () => {
        it('creates the server with the electionTimeoutWindow', ctx => {
          const values = [10, 20]
          ctx.createServer({ electionTimeoutWindow: values })
          assert(ctx.Server.calledOnce)
          const { args: [{ electionTimeoutWindow }] } = ctx.Server.firstCall
          assert(electionTimeoutWindow === values)
        })
      })
    })

    param('heartbeatInterval', () => {
      ;[
        { desc: 'not an integer', value: '🙈' },
        { desc: 'less than zero', value: -1 },
        { desc: '0', value: 0 }
      ].forEach(({ desc, value }) => {
        context(`it is ${desc}`, () => {
          it('causes a TypeError to be thrown', ctx => {
            assert.throws(
              () => ctx.createServer({ heartbeatInterval: value }),
              TypeError,
              "Parameter 'heartbeatInterval' must be an integer, greater than zero")
          })
        })
      })

      context('is an integer greater than zero', () => {
        it('creates the server with the heartbeatInterval', ctx => {
          ctx.createServer({ heartbeatInterval: 5 })
          assert(ctx.Server.calledOnce)
          const { args: [{ heartbeatInterval }] } = ctx.Server.firstCall
          assert(heartbeatInterval === 5)
        })
      })
    })

    const functionParam = (name, wrapped = false) => {
      param(name, () => {
        context('it is not a function', () => {
          it('causes a TypeError to be thrown', ctx => {
            assert.throws(
              () => ctx.createServer({ [name]: 42 }),
              TypeError,
              `Parameter '${name}' must be a function, not number`)
          })
        })

        context('is a function', () => {
          if (!wrapped) {
            it(`creates the server with the ${name}`, ctx => {
              const fn = () => {}
              ctx.createServer({ [name]: fn })
              assert(ctx.Server.calledOnce)
              const { args: [{ [name]: received }] } = ctx.Server.firstCall
              assert(received === fn)
            })
          } else {
            it(`creates the server with a Promise-wrapper for the ${name}`, ctx => {
              ctx.createServer({ [name] () {} })
              assert(ctx.Server.calledOnce)
              const { args: [{ [name]: wrapper }] } = ctx.Server.firstCall
              assert(typeof wrapper === 'function')
            })

            describe('the Promise-wrapper', () => {
              beforeEach(ctx => {
                ctx.original = stub()
                ctx.createServer({ [name]: ctx.original })
                assert(ctx.Server.calledOnce)
                const { args: [{ [name]: wrapper }] } = ctx.Server.firstCall
                ctx.wrapper = wrapper
              })

              it('invokes the original function', ctx => {
                const args = []
                for (let i = 0; i < ctx.wrapper.length; i++) {
                  args.push(Symbol())
                }
                ctx.wrapper(...args)

                assert(ctx.original.calledOnce)
                const { args: propagated } = ctx.original.firstCall
                assert.deepStrictEqual(propagated, args)
              })

              context('the original function returns a promise', () => {
                context('the promise is fulfilled', () => {
                  it('fulfills the promise returned by the wrapper', async ctx => {
                    const value = Symbol()
                    ctx.original.returns(Promise.resolve(value))
                    assert(await ctx.wrapper() === value)
                  })
                })

                context('the promise is rejected', () => {
                  it('rejects the promise returned by the wrapper', async ctx => {
                    const err = Symbol()
                    ctx.original.returns(Promise.reject(err))
                    assert(await getReason(ctx.wrapper()) === err)
                  })
                })
              })

              context('the original function returns a non-promise value', () => {
                it('fulfills the promise returned by the wrapper with the value', async ctx => {
                  const value = Symbol()
                  ctx.original.returns(value)
                  assert(await ctx.wrapper() === value)
                })
              })

              context('the original function throws an error', () => {
                it('rejects the promise returned by the wrapper with the error', async ctx => {
                  const err = Symbol()
                  ctx.original.throws(err)
                  assert(await getReason(ctx.wrapper()) === err)
                })
              })
            })
          }
        })
      })
    }

    functionParam('createTransport')
    functionParam('persistState', true)
    functionParam('persistEntries', true)
    functionParam('applyEntry', true)
    functionParam('crashHandler')
  })
})
