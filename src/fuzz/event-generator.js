export const Append = Symbol('Append')
export const Kill = Symbol('Kill')
export const Partition = Symbol('Partition')
export const Restart = Symbol('Restart')
export const RunSimulation = Symbol('RunSimulation')
export const UndoPartition = Symbol('UndoPartition')

export const AdvanceClock = Symbol('AdvanceClock')
export const CallOrDeliver = Symbol('CallOrDeliver')
export const Deliver = Symbol('Deliver')
export const DeliverAndRequeue = Symbol('DeliverAndRequeue')
export const Drop = Symbol('Drop')
export const Requeue = Symbol('Requeue')
export const FailCall = Symbol('FailCall')

const WorldWeights = {
  [Append]: 8,
  [Kill]: 1,
  [Partition]: 1,
  [Restart]: 10,
  [RunSimulation]: 70,
  [UndoPartition]: 10
  // TODO Send messages from non-peers
}

const SimulationWeights = {
  [AdvanceClock]: 50,
  [CallOrDeliver]: 724,
  [Deliver]: 100,
  [DeliverAndRequeue]: 50,
  [Drop]: 10,
  [Requeue]: 100,
  [FailCall]: 1
}

const WorldEvents = Object.getOwnPropertySymbols(WorldWeights)
export function pickWorldEvent () {
  return pick(WorldEvents, WorldWeights)
}

const SimulationEvents = Object.getOwnPropertySymbols(SimulationWeights)
export function pickSimulationEvent () {
  return pick(SimulationEvents, SimulationWeights)
}

// Weighted random selection
function pick (events, weights) {
  let totalWeight = 0
  let selected = null
  for (const event of events) {
    const weight = weights[event]
    totalWeight += weight
    if (Math.random() * totalWeight < weight) {
      selected = event
    }
  }
  return selected
}
