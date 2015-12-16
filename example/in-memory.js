import { Duplex, Readable } from 'stream'
import chalk from 'chalk'

import { createServer } from '../'

const inputWritters = new Map()

class Transport {
  constructor (fromAddress) {
    this.fromAddress = fromAddress
    this.nonPeerStream = new Readable({ objectMode: true, read () {} })
  }

  listen () {
    return this.nonPeerStream
  }

  connect ({ address: peerAddress, writeOnly = false }) {
    // N.B. writeOnly is used when creating a peer instance for a non-peer
    // receiver, which does not occur in this example.
    const stream = new Duplex({
      objectMode: true,
      read () {},
      write: (message, _, done) => {
        console.log(chalk.cyan(`${this.fromAddress.serverId} --> ${peerAddress.serverId}`), message)
        process.nextTick(() => inputWritters.get(peerAddress.serverId)(message))
        done()
      }
    })
    inputWritters.set(this.fromAddress.serverId, message => stream.push(message))

    return stream
  }
}

const cluster = new Map(['alice', 'bob'].map(serverId => {
  const server = createServer({
    address: `in-memory:///${serverId}`,
    electionTimeoutWindow: [5000, 6000],
    heartbeatInterval: 2500,
    createTransport (fromAddress) { return new Transport(fromAddress) },
    persistState (state) {
      console.log(`${chalk.red(serverId)} persistState`, state)
    },
    persistEntries (entries) {
      console.log(`${chalk.red(serverId)} persistEntries`, entries)
    },
    applyEntry (entry) {
      console.log(`${chalk.red(serverId)} applyEntry`, entry)
      return 'oh hai!'
    },
    crashHandler (err) {
      console.error(`${chalk.red(serverId)} crashed!`, err && err.stack || err)
    }
  })
  server.on('candidate', () => console.log(`${chalk.red(serverId)} is candidate`))
  server.on('follower', () => console.log(`${chalk.red(serverId)} is follower`))
  server.on('leader', () => console.log(`${chalk.red(serverId)} is leader`))

  return [server.address, server]
}))

for (const [address, server] of cluster) {
  const joinAddresses = Array.from(cluster.keys()).filter(peerAddress => peerAddress !== address)
  server.join(joinAddresses).then(() => {
    console.log(`${chalk.red(server.id)} joined`)
  }, err => console.error(`${chalk.red(server.id)} listen error`, err && err.stack || err))
}

Promise.race(Array.from(cluster, ([, server]) => {
  return new Promise(resolve => server.once('leader', () => resolve(server)))
})).then(leader => {
  return leader.append('hello world').then(result => {
    console.log(`${chalk.red(leader.id)} append result`, result)
  })
}).catch(err => console.error(err && err.stack || err))
