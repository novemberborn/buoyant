// Mocha exposes its BDD interface as globals, which fails linting unless
// they're whitelisted in each test file. Instead provide module which wraps
// these globals. Additionally Mocha passes the test context as the thisArg. The
// wrapped methods pass it as the first argument instead. Support for done()
// callbacks is dropped in favor of using promises and async/await in the tests.
//
// Inspired by <https://github.com/freeqaz/global-mocha> and
// <https://github.com/skozin/arrow-mocha>.

/*global
  after:false, afterEach:false,
  before:false, beforeEach:false,
  context:false, describe:false,
  it:false
*/
const mochaGlobals = {
  after, afterEach,
  before, beforeEach,
  context, describe,
  it
}

function contextify (fn) {
  if (typeof fn !== 'function') {
    return fn
  }

  return function () { return fn(this) }
}

const {
  _after, _afterEach,
  _before, _beforeEach,
  _context, _describe,
  _it
} = Object.keys(mochaGlobals).reduce((wrapped, methodName) => {
  const method = mochaGlobals[methodName]
  if (/describe|context|it/.test(methodName)) {
    wrapped[`_${methodName}`] = (desc, fn) => method(desc, contextify(fn))
    wrapped[`_${methodName}`].only = (desc, fn) => method.only(desc, contextify(fn))
    wrapped[`_${methodName}`].skip = (desc, fn) => method.skip(desc, contextify(fn))
  } else {
    wrapped[`_${methodName}`] = fn => method(contextify(fn))
  }
  return wrapped
}, {})

export {
  _after as after,
  _afterEach as afterEach,
  _before as before,
  _beforeEach as beforeEach,
  _context as context,
  _describe as describe,
  _it as it
}
