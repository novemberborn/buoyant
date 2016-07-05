import metasyntacticVariables from 'metasyntactic-variables'

import Address from '../lib/Address'
import exposeEvents from '../lib/expose-events'

import intInRange from './int-in-range'
import Network from './Network'
import pickRandom from './pick-random'
import Simulation from './Simulation'
import QueueManager from './QueueManager'

const idPrefixes = metasyntacticVariables.filter(prefix => {
  // Reject prefixes that look too similar to others (bar and qux respectively).
  return prefix !== 'baz' && prefix !== 'quux'
})

function sequentialServerId (seq) {
  let id = idPrefixes[seq % idPrefixes.length]
  if (seq >= idPrefixes.length) {
    id += Math.floor(seq / idPrefixes.length) + 1
  }
  return id
}

export default class Configuration {
  constructor ({
    clusterSize,
    electionTimeoutWindow = [150, 300],
    heartbeatInterval = 30,
    maxClockSkew = 500,
    reporter
  }) {
    this.addresses = Array.from({ length: clusterSize }, (_, seq) => new Address(`///${sequentialServerId(seq)}`))
    Object.assign(this, { electionTimeoutWindow, heartbeatInterval, maxClockSkew, reporter })

    const emitter = exposeEvents(this)
    this.emit = emitter.emit.bind(emitter)

    this.latestTime = { sinceEpoch: 0, vector: 0 }
    this.queueManager = new QueueManager()
    this.simulations = new Map()

    this.network = new Network({
      enqueueDelivery: this.queueManager.enqueueDelivery.bind(this.queueManager),
      getSimulation: this.getSimulation.bind(this),
      reporter
    })

    for (const address of this.addresses) {
      this.simulations.set(address, this.createSimulation(address))
    }
  }

  createSimulation (address, restartOptions = null) {
    const {
      electionTimeoutWindow,
      emit,
      heartbeatInterval,
      network,
      queueManager,
      reporter
    } = this

    const electionTimeout = intInRange(electionTimeoutWindow)
    if (restartOptions) {
      reporter.restartServer(address, heartbeatInterval, electionTimeout)
    } else {
      reporter.createServer(address, heartbeatInterval, electionTimeout)
    }

    return new Simulation(Object.assign({
      address,
      createTransport: network.createTransport.bind(network),
      electionTimeout,
      heartbeatInterval,
      queueManager,
      reportStateChange: (type, args) => emit('stateChange', { address, args, type })
    }, restartOptions))
  }

  getSimulation (address) {
    return this.simulations.get(address) || null
  }

  getRandomSimulation () {
    const alive = Array.from(this.simulations.values())
    return pickRandom(alive) || null
  }

  getEarliestSimulation () {
    let earliest = null
    let earliestTime = { sinceEpoch: Infinity, vector: Infinity }
    for (const simulation of this.simulations.values()) {
      const time = simulation.currentTime
      if (!earliest || time.sinceEpoch < earliestTime.sinceEpoch) {
        [earliest, earliestTime] = [simulation, time]
      } else if (time.sinceEpoch === earliestTime.sinceEpoch) {
        if (time.vector < earliestTime.vector) {
          [earliest, earliestTime] = [simulation, time]
        } else if (time.vector === earliestTime.vector && Math.random() < 0.5) {
          [earliest, earliestTime] = [simulation, time]
        }
      }
    }

    return earliest
  }

  getTrailingSimulation () {
    const sorted = Array.from(this.simulations.values(),
      simulation => {
        return { simulation, time: simulation.currentTime }
      })
      .sort(({ time: a }, { time: b }) => {
        if (a.sinceEpoch < b.sinceEpoch) {
          return -1
        } else if (a.sinceEpoch === b.sinceEpoch) {
          if (a.vector < b.vector) {
            return -1
          } else if (a.vector === b.vector && Math.random() < 0.5) {
            return -1
          }
        }
        return 1
      })

    const last = sorted.pop()
    const exceededMaxSkew = sorted.find(({ time }) => last.time.sinceEpoch - time.sinceEpoch > this.maxClockSkew)
    return exceededMaxSkew ? exceededMaxSkew.simulation : this.getRandomSimulation()
  }

  hasActiveSimulations () {
    return this.simulations.size > 0
  }

  getLogs () {
    return Array.from(this.simulations, ([address, { log }]) => ({ address, log }))
  }

  joinInitialCluster () {
    return Promise.all(this.addresses.map(address => {
      const cluster = this.addresses.filter(other => other !== address)
      return this.getSimulation(address).joinInitialCluster(cluster)
    }))
  }

  advanceClock (simulation) {
    this.reporter.advanceClock(simulation)

    const time = simulation.advanceClock()
    const { sinceEpoch, vector } = this.latestTime
    if (time.sinceEpoch > sinceEpoch || time.sinceEpoch === sinceEpoch && time.vector > vector) {
      this.latestTime = time
    }
  }

  advanceTrailingClock () {
    const simulation = this.getTrailingSimulation()
    if (!simulation) {
      throw new Error('Cannot advance trailing clock simulation, no active simulations are remaining')
    }

    this.advanceClock(simulation)
  }

  triggerElection () {
    let earliest = null
    let earliestTime = Infinity
    for (const [, simulation] of this.simulations) {
      const { electionTimeout } = simulation
      if (!earliest || electionTimeout < earliestTime) {
        [earliest, earliestTime] = [simulation, electionTimeout]
      }
    }

    this.advanceClock(earliest)
    return earliest
  }

  async killRandomSimulation () {
    const simulation = this.getRandomSimulation()
    if (!simulation) {
      throw new Error('Cannot kill simulation, no active simulations are remaining')
    }

    return this.killSimulation(simulation.address)
  }

  async killSimulation (address, afterCrash = false) {
    const simulation = this.simulations.get(address)
    if (!simulation) {
      throw new Error('Cannot kill simulation that is already dead')
    }

    if (afterCrash) {
      this.reporter.killAfterCrash(simulation)
    } else {
      this.reporter.kill(simulation)
    }

    await simulation.destroy()
    this.simulations.delete(address)
    this.queueManager.delete(address)
    return simulation
  }

  async restartSimulation (address, restoreEntries, restoreLastApplied, restoreState, time) {
    if (this.simulations.has(address)) {
      throw new Error('Cannot restart simulation that is already active')
    }

    // Start the new simulation at the earliest time of the remaining
    // simulations, or after the last time seen in the configuration if there
    // are no remaining simulations.
    const earliest = this.getEarliestSimulation()
    const { sinceEpoch: epoch } = earliest ? earliest.currentTime : this.latestTime
    const { vector } = time
    const simulation = this.createSimulation(address, {
      restoreEntries,
      restoreLastApplied,
      restoreState,
      time: { epoch, vector }
    })
    this.simulations.set(address, simulation)

    // Advance the clock so the new simulation isn't actually the earliest when
    // it joins the cluster.
    this.advanceClock(simulation)

    const cluster = this.addresses.filter(other => other !== address)
    await simulation.joinInitialCluster(cluster)
  }
}
