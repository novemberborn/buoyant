import test from 'ava'
import Entry from '../lib/Entry'
import macro from './helpers/macro'

const throwsTypeError = macro((t, values, message) => {
  t.throws(() => new Entry(...values), TypeError, message)
}, suffix => `throw when constructed with ${suffix}`)

const hasField = macro((t, param, expected) => {
  const args = [1, 1, '🙊']
  args[{ index: 0, term: 1, value: 2 }[param]] = expected
  const entry = new Entry(...args)
  t.true(entry[param] === expected)
}, (_, param, value) => `entry constructed with ${param}=${value.toString()} has the correct ${param} field`)

const checkFieldConfiguration = macro((t, field) => {
  const entry = new Entry(1, 1, '🙊')
  const { configurable, enumerable, writable } = Object.getOwnPropertyDescriptor(entry, field)
  t.false(configurable)
  t.true(enumerable)
  t.false(writable)
}, (_, field) => `configuration of ${field} field is correct`)

test('an index that is not an integer', throwsTypeError, ['🙊', 1], "Parameter 'index' must be a safe integer, greater or equal than 1")
test('an index that is not a safe integer', throwsTypeError, [Number.MAX_SAFE_INTEGER + 1, 1], "Parameter 'index' must be a safe integer, greater or equal than 1")
test('an index that is lower than 1', throwsTypeError, [0, 1], "Parameter 'index' must be a safe integer, greater or equal than 1")
test('a term that is an integer', throwsTypeError, [1, '🙊'], "Parameter 'term' must be a safe integer, greater or equal than 1")
test('a term that is not a safe integer', throwsTypeError, [1, Number.MAX_SAFE_INTEGER + 1], "Parameter 'term' must be a safe integer, greater or equal than 1")
test('a term that is lower than 1', throwsTypeError, [1, 0], "Parameter 'term' must be a safe integer, greater or equal than 1")

test(hasField, 'index', 1)
test(hasField, 'term', 2)
test(hasField, 'value', Symbol())

test(checkFieldConfiguration, 'index')
test(checkFieldConfiguration, 'term')
test(checkFieldConfiguration, 'value')
