import * as symbols from './lib/symbols'
import Address from './lib/Address'
import Entry from './lib/Entry'
import Server from './lib/Server'

export { symbols, Address, Entry }

// Creates the server instance, validating the arguments and wrapping them if
// necessary. The network transport, state persistence and the state machine are
// to be implemented outside of the server and exposed to the server via the
// various parameters.
export function createServer ({
  address,
  applyEntry,
  crashHandler,
  createTransport,
  electionTimeoutWindow,
  heartbeatInterval,
  persistEntries,
  persistState
}) {
  if (typeof address === 'string') {
    address = new Address(address)
  } else if (!Address.is(address)) {
    throw new TypeError("Parameter 'address' must be a string or an Address instance")
  }

  if (typeof applyEntry !== 'function') {
    throw new TypeError(`Parameter 'applyEntry' must be a function, not ${typeof applyEntry}`)
  }

  if (typeof crashHandler !== 'function') {
    throw new TypeError(`Parameter 'crashHandler' must be a function, not ${typeof crashHandler}`)
  }

  if (typeof createTransport !== 'function') {
    throw new TypeError(`Parameter 'createTransport' must be a function, not ${typeof createTransport}`)
  }

  try {
    const [first, last] = electionTimeoutWindow
    if (!Number.isInteger(first) || !Number.isInteger(last)) {
      throw new TypeError("Values of parameter 'electionTimeoutWindow' must be integers")
    }
    if (first <= 0) {
      throw new TypeError("First value of parameter 'electionTimeoutWindow' must be greater than zero")
    }
    if (first >= last) {
      throw new TypeError("Second value of parameter 'electionTimeoutWindow' must be greater than the first")
    }
  } catch (_) {
    throw new TypeError("Parameter 'electionTimeoutWindow' must be iterable")
  }

  if (!Number.isInteger(heartbeatInterval) || heartbeatInterval <= 0) {
    throw new TypeError("Parameter 'heartbeatInterval' must be an integer, greater than zero")
  }

  if (typeof persistEntries !== 'function') {
    throw new TypeError(`Parameter 'persistEntries' must be a function, not ${typeof persistEntries}`)
  }

  if (typeof persistState !== 'function') {
    throw new TypeError(`Parameter 'persistState' must be a function, not ${typeof persistState}`)
  }

  return new Server({
    address,
    applyEntry: async entry => applyEntry(entry),
    crashHandler,
    createTransport,
    electionTimeoutWindow,
    heartbeatInterval,
    id: address.serverId,
    persistEntries: async entries => persistEntries(entries),
    persistState: async state => persistState(state)
  })
}
