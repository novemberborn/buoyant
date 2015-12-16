import Configuration from './lib/Configuration'
import Orchestrator from './lib/Orchestrator'

const configuration = new Configuration(5)
const orchestrator = new Orchestrator(configuration)

orchestrator.log.on('data', item => console.log(item))

orchestrator.run().catch(err => {
  console.error(err && err.stack || err)
  process.exit(1)
})

/*
let crashed = false
let progress = 0
let lastProgress = -1
let cyclesSinceProgress = 0
const maxCyclesWithoutProgress = 100

C.on('stateChange', (process, event, ...args) => {
  if (event === 'crash') {
    crashed = true
    const [err] = args
    console.error('crash', process.address, err && err.stack || err)
    return
  }

  console.log('stateChange', process.address, event, ...args)
  progress++
})

C.joinInitialCluster()
  .then(() => new Promise(repeat))
  .catch(err => {
    crashed = true
    console.error('uncaughtException', err && err.stack || err)
  })
  .then(() => {
    console.log('Total progress', progress)
    process.exit(crashed ? 1 : 0)
  })

function step () {
  const event = C.internalEvents.shift()
  if (event) {
    console.log('internalEvent', event.event, event.process.address, event.timestamp, event.args)
    event.resolve()
    progress++
    return
  }

  const entry = C.network.dequeue()
  if (entry) {
    if (Math.random() < 0.8) {
      console.log('networkDelivery', entry.sender, '->', entry.receiver, entry.timestamp, entry.id, entry.delivered, entry.message)
      entry.deliver()
      if (Math.random() < 0.2) {
        console.log('networkRequeue', entry.sender, '->', entry.receiver, entry.timestamp, entry.id, entry.delivered, entry.message)
        entry.requeue()
      }
    } else {
      console.log('networkDrop', entry.sender, '->', entry.receiver, entry.timestamp, entry.id, entry.delivered, entry.message)
    }
    return
  }

  const process = C.randomProcess()
  if (Math.random() < 0.5) {
    console.log('advanceClock', process.address)
    process.advanceClock()
    return
  }
}

function repeat (done, fail) {
  if (crashed) {
    return done()
  }

  if (lastProgress === progress) {
    cyclesSinceProgress++
    if (cyclesSinceProgress === maxCyclesWithoutProgress) {
      console.log(`No progress in ${maxCyclesWithoutProgress} cycles, stopping.`)
      return done()
    }
  } else {
    lastProgress = progress
    cyclesSinceProgress = 0
  }

  return new Promise(resolve => resolve(step()))
    .then(() => repeat(done, fail), fail)
}
*/
