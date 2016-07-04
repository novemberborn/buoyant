import test from 'ava'
import { stub } from 'sinon'
import Address from 'dist/lib/Address'
import macro from './helpers/macro'

const throwsTypeError = macro((t, url, message) => {
  t.throws(() => new Address(url), TypeError, message)
}, suffix => `throw when constructed with a URL that ${suffix}`)

const hasFields = macro((t, url, expected) => {
  const address = new Address(url)
  t.deepEqual(address, expected)
}, (_, url) => `address for ${url} has expected fields`)

const checkFieldConfiguration = macro((t, field) => {
  const address = new Address('protocol://hostname/👾')
  const { configurable, enumerable, writable } = Object.getOwnPropertyDescriptor(address, field)
  t.false(configurable)
  t.true(enumerable)
  t.false(writable)
}, (_, field) => `configuration of ${field} field is correct`)

const testToString = macro((t, url) => {
  const address = new Address(url)
  t.true(address.toString() === url)
}, (_, url) => `toString() of address with URL ${url} returns the equivalent URL string`)

test('is not a string', throwsTypeError, undefined, "Parameter 'url' must be a string, not undefined")
test('has a protocol but no slashes', throwsTypeError, 'protocol:hostname/pathname', "Parameter 'url' requires protocol to be postfixed by ://")
test('has no protocol and no slashes', throwsTypeError, 'hostname/pathname', "Parameter 'url' must start with // if no protocol is specified")
test('has no pathname', throwsTypeError, 'protocol://hostname', 'Address must include a server ID')
test('has / as its pathname', throwsTypeError, 'protocol://hostname/', 'Address must include a server ID')

{
  const [protocol, hostname, serverId] = ['protocol', 'hostname', 'serverId']
  test(hasFields, 'protocol://hostname:42/serverId', { protocol, hostname, port: 42, serverId })
  test(hasFields, 'protocol://hostname/serverId', { protocol, hostname, port: null, serverId })
  test(hasFields, '//hostname/serverId', { protocol: null, hostname, port: null, serverId })
  test(hasFields, '///serverId', { protocol: null, hostname: null, port: null, serverId })
}

test(checkFieldConfiguration, 'protocol')
test(checkFieldConfiguration, 'hostname')
test(checkFieldConfiguration, 'port')
test(checkFieldConfiguration, 'serverId')

test(testToString, 'protocol://hostname:42/serverId')
test(testToString, 'protocol://hostname/serverId')
test(testToString, 'protocol:///serverId')
test(testToString, '//hostname:42/serverId')
test(testToString, '//hostname/serverId')
test(testToString, '///serverId')

test('inspect() returns a string serialization of the address', t => {
  const address = new Address('///👾')
  stub(address, 'toString').returns('🎈')
  t.true(address.inspect() === '[buoyant:Address 🎈]')
})

test('is(obj) recognizes Address instances', t => {
  t.true(Address.is(new Address('///👾')))
})

test('is(obj) recognizes objects tagged with the buoyant:Address symbol', t => {
  t.true(Address.is({ [Symbol.for('buoyant:Address')]: true }))
})

test('is(obj) does not recognize other objects', t => {
  t.false(Address.is({}))
})

test('is(obj) does not recognize the undefined value', t => {
  t.false(Address.is(undefined))
})

test('is(obj) does not recognize the null value', t => {
  t.false(Address.is(null))
})
