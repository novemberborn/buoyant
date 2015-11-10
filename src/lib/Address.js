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
  constructor ({ protocol = null, hostname = null, port = null, serverId }) {
    if (typeof serverId !== 'string' || !serverId) {
      throw new TypeError("Parameter 'serverId' must be a non-empty string")
    } else if (serverId.startsWith('/')) {
      throw new TypeError("Parameter 'serverId' must not start with a slash")
    }

    Object.defineProperties(this, {
      protocol: { value: protocol, enumerable: true },
      hostname: { value: hostname, enumerable: true },
      port: { value: port, enumerable: true },
      serverId: { value: serverId, enumerable: true },
      [tag]: { value: true }
    })
  }

  static fromUrl (url) {
    if (typeof url !== 'string') {
      throw new TypeError(`Parameter 'url' must be a string, not ${typeof url}`)
    }

    let { protocol, hostname, port, pathname: serverId } = parse(url, false, true)

    if (port !== null) {
      // If the port is not in the URL, or is not an integer, it'll come back as
      // null. Otherwise it's a string that will be safe to parse as an integer.
      port = Number.parseInt(port, 10)
    }

    serverId = (serverId || '').slice(1) // Strip leading slash, if any
    if (!serverId) {
      throw new TypeError('Address must include a server ID')
    }

    return new Address({ protocol, hostname, port, serverId })
  }

  static is (obj) {
    return obj[tag] === true
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
