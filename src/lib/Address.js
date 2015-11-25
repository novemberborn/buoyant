import { parse, format } from 'url'

const tag = Symbol.for('buoyant:Address')

// Locates a server within the Raft cluster. The `protocol`, `hostname` and
// `port` values are optional. They are used by the transport to route messages
// between the servers. `serverId` is required and identifies a particular
// server. Addresses with different `protocol`, `hostname` or `port` values but
// the same `serverId` identify the same server.
//
// Addresses can be parsed from, and serialized to, a URL string. The `serverId`
// will be taken from the pathname (without the leading slash).
export default class Address {
  constructor (url) {
    if (typeof url !== 'string') {
      throw new TypeError(`Parameter 'url' must be a string, not ${typeof url}`)
    }

    let { protocol, slashes, hostname, port, pathname: serverId } = parse(url, false, true)
    if (!slashes) {
      if (protocol) {
        throw new TypeError("Parameter 'url' requires protocol to be postfixed by ://")
      } else {
        throw new TypeError("Parameter 'url' must start with // if no protocol is specified")
      }
    }

    if (protocol) {
      // Normalize protocol by removing the postfixed colon.
      protocol = protocol.replace(/:$/, '')
    }
    if (hostname === '') {
      // Normalize empty hostnames to `null`
      hostname = null
    }
    if (port !== null) {
      // If the port is not in the URL, or is not an integer, it'll come back as
      // null. Otherwise it's a string that will be safe to parse as an integer.
      port = Number.parseInt(port, 10)
    }

    serverId = (serverId || '').replace(/^\//, '') // Strip leading slash, if any
    if (!serverId) {
      throw new TypeError('Address must include a server ID')
    }

    Object.defineProperties(this, {
      protocol: { value: protocol, enumerable: true },
      hostname: { value: hostname, enumerable: true },
      port: { value: port, enumerable: true },
      serverId: { value: serverId, enumerable: true },
      [tag]: { value: true }
    })
  }

  static is (obj) {
    return obj ? obj[tag] === true : false
  }

  toString () {
    return format({
      protocol: this.protocol,
      slashes: true,
      hostname: this.hostname,
      port: this.port,
      pathname: this.serverId // format() will add the leading slash for the pathname
    })
  }

  inspect () {
    return `[buoyant:Address ${this}]`
  }
}
