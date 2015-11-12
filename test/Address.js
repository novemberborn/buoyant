import { before, context, describe, it } from '!mocha'
import assert from 'power-assert'
import sinon from 'sinon'

import Address from '../lib/Address'

describe('Address', () => {
  describe('constructor (url)', () => {
    context('url is not a string', () => {
      it('throws a TypeError', () => {
        assert.throws(() => new Address(undefined), TypeError, "Parameter 'url' must be a string, not undefined")
      })
    })

    ;[
      { desc: 'has a protocol but no slashes', url: 'protocol:hostname/pathname', message: "Parameter 'url' requires protocol to be postfixed by ://" },
      { desc: 'has no protocol and no slashes', url: 'hostname/pathname', message: "Parameter 'url' must start with // if no protocol is specified" },
      { desc: 'has no pathname', url: 'protocol://hostname', message: 'Address must include a server ID' },
      { desc: 'has / as its pathname', url: 'protocol://hostname/', message: 'Address must include a server ID' }
    ].forEach(({ desc, url, message }) => {
      context(`url ${desc}`, () => {
        it('throws a TypeError', () => {
          assert.throws(() => new Address(url), TypeError, message)
        })
      })
    })

    describe('the instance', () => {
      const protocol = 'protocol'
      const hostname = 'hostname'
      const serverId = 'serverId'
      ;[
        {
          url: 'protocol://hostname:42/serverId',
          fields: { protocol, hostname, port: 42, serverId }
        },
        {
          url: 'protocol://hostname/serverId',
          fields: { protocol, hostname, port: null, serverId }
        },
        {
          url: '//hostname/serverId',
          fields: { protocol: null, hostname, port: null, serverId }
        },
        {
          url: '///serverId',
          fields: { protocol: null, hostname: null, port: null, serverId }
        }
      ].forEach(({ url, fields }) => {
        context(`with url <${url}>`, () => {
          before(ctx => ctx.address = new Address(url))

          for (const field in fields) {
            const value = fields[field]
            it(`has a ${field} field with value '${JSON.stringify(value)}'`, ctx => {
              assert(ctx.address[field] === value)
            })
          }
        })
      })
    })
  })

  ;['protocol', 'hostname', 'port', 'serverId'].forEach(field => {
    describe(`#${field}`, () => {
      before(ctx => {
        const address = new Address('protocol://hostname/👾')
        ctx.descriptor = Object.getOwnPropertyDescriptor(address, field)
      })

      it('is not writable', ctx => {
        assert(ctx.descriptor.writable === false)
      })

      it('is not configurable', ctx => {
        assert(ctx.descriptor.configurable === false)
      })

      it('is enumerable', ctx => {
        assert(ctx.descriptor.enumerable === true)
      })
    })
  })

  describe('#toString ()', () => {
    ;[
      'protocol://hostname:42/serverId',
      'protocol://hostname/serverId',
      'protocol:///serverId',
      '//hostname:42/serverId',
      '//hostname/serverId',
      '///serverId'
    ].forEach(url => {
      context(`the address was created with url <${url}>`, () => {
        it(`returns <${url}>`, () => {
          assert(new Address(url).toString() === url)
        })
      })
    })
  })

  describe('#inspect ()', () => {
    it('returns a string serialization of the address', () => {
      const address = new Address('///👾')
      sinon.stub(address, 'toString').returns('🎈')
      assert(address.inspect() === '[buoyant:Address 🎈]')
    })
  })

  describe('static is (obj)', () => {
    it('recognizes Address instances', () => {
      assert(Address.is(new Address('///👾')))
    })

    it('recognizes objects tagged with the buoyant:Address symbol', () => {
      assert(Address.is({ [Symbol.for('buoyant:Address')]: true }))
    })

    it('does not recognize other objects', () => {
      assert(!Address.is({}))
    })

    it('does not recognize the undefined value', () => {
      assert(!Address.is(undefined))
    })

    it('does not recognize the null value', () => {
      assert(!Address.is(null))
    })
  })
})
