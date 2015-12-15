import variables from 'metasyntactic-variables'

import Network from './Network'
import Process from './Process'

import { Address } from '🏠'
import exposeEvents from '🏠/lib/expose-events'

function sequentialServerId (seq) {
  let id = variables[seq % variables.length]
  if (seq >= variables.length) {
    id += Math.floor(seq / variables.length) + 1
  }
  return id
}

export default class Configuration {
  constructor (initialClusterSize) {
    const emitter = exposeEvents(this)

    this.addresses = new Array(initialClusterSize)
    this.internalEvents = []
    this.processes = new Map()
    this.network = new Network({
      getProcess: address => this.processes.get(address)
    })

    const createTransport = this.network.createTransport.bind(this.network)
    for (let i = 0; i < initialClusterSize; i++) {
      const address = this.addresses[i] = new Address(`///${sequentialServerId(i)}`)
      const process = new Process(address, createTransport)
      this.processes.set(address, process)

      ;['applyEntry', 'persistEntries', 'persistState'].forEach(event => {
        process.on(event, (resolve, reject, ...args) => {
          this.internalEvents.push({
            args,
            event,
            process,
            reject,
            resolve,
            timestamp: process.currentTime
          })
        })
      })

      ;['candidate', 'crash', 'follower', 'leader'].forEach(event => {
        process.on(event, (...args) => emitter.emit('stateChange', process, event, ...args))
      })
    }
  }

  joinInitialCluster () {
    return Promise.all(this.addresses.map(address => {
      const cluster = this.addresses.filter(other => other !== address)
      return this.processes.get(address).joinInitialCluster(cluster)
    }))
  }

  randomProcess () {
    const address = this.addresses[Math.floor(Math.random() * this.addresses.length)]
    return this.processes.get(address)
  }
}
