/* eslint-disable ava/no-ignored-test-files */
const test = require('ava')
const proxyquire = require('proxyquire')
const { spy, stub } = require('sinon')

const { default: ActualInputConsumer } = require('../../lib/InputConsumer')
const { default: ActualScheduler } = require('../../lib/Scheduler')

function setupConstructors (roleSource) {
  const shared = {
    InputConsumer () {},
    Scheduler () {}
  }

  const { default: Role } = proxyquire.noCallThru()(roleSource, {
    '../InputConsumer': function (...args) { return shared.InputConsumer(...args) },
    '../Scheduler': function (...args) { return shared.Scheduler(...args) }
  })

  test.beforeEach(t => {
    const InputConsumer = spy(function (...args) { return new ActualInputConsumer(...args) })
    const Scheduler = spy(function (...args) { return new ActualScheduler(...args) })

    // Note that the next tests' beforeEach hook overrides the shared stubs.
    // Tests where these classes are instantiated /*async*/hronously need to be
    // marked as serial.
    Object.assign(shared, { InputConsumer, Scheduler })

    Object.assign(t.context, { InputConsumer, Scheduler })
  })

  return Role
}

function testFollowerConversion (type) {
  const setup = context => {
    const { [type]: role, state } = context
    state._currentTerm.returns(1)
    const message = { term: 2 }
    return Object.assign({ message, role }, context)
  }

  test('handleMessage() sets the term to that of the message, if it has a newer term', t => {
    const { message, peers: [peer], role, state } = setup(t.context)
    role.handleMessage(peer, message)
    t.true(state.setTerm.calledOnce)
    const { args: [term] } = state.setTerm.firstCall
    t.true(term === 2)
  })

  test('handleMessage() returns a promise if the message has a newer term', t => {
    const { message, peers: [peer], role } = setup(t.context)
    t.true(role.handleMessage(peer, message) instanceof Promise)
  })

  test(`if the role was destroyed while persisting the state, handleMessage() won’t convert the ${type} to follower if the message has a newer term`, t => {
    const { convertToFollower, message, peers: [peer], role, state } = setup(t.context)
    let persisted
    state.setTerm.returns(new Promise(resolve => {
      persisted = resolve
    }))

    role.handleMessage(peer, message)
    role.destroy()
    persisted()

    return Promise.resolve().then(() => {
      t.true(convertToFollower.notCalled)
      return
    })
  })

  test(`handleMessage() converts the ${type} to follower if the message has a newer term`, t => {
    const { convertToFollower, message, peers: [peer], role } = setup(t.context)
    return role.handleMessage(peer, message).then(() => {
      t.true(convertToFollower.calledOnce)
      const { args: [[receivedPeer, receivedMessage]] } = convertToFollower.firstCall
      t.true(receivedPeer === peer)
      t.true(receivedMessage === message)
      return
    })
  })
}

function testInputConsumerDestruction (type) {
  test('destroy() stops the input consumer', t => {
    const { [type]: role } = t.context
    spy(role.inputConsumer, 'stop')
    role.destroy()
    t.true(role.inputConsumer.stop.calledOnce)
  })
}

function testInputConsumerInstantiation (type) {
  test('instantiate an input consumer', t => {
    const { [type]: role, crashHandler, InputConsumer, peers, nonPeerReceiver } = t.context

    t.true(role.inputConsumer instanceof ActualInputConsumer)
    t.true(InputConsumer.calledOnce)
    const { args: [{ peers: receivedPeers, nonPeerReceiver: receivedNonPeerReceiver, scheduler, handleMessage, crashHandler: receivedCrashHandler }] } = InputConsumer.firstCall
    t.true(receivedPeers === peers)
    t.true(receivedNonPeerReceiver === nonPeerReceiver)
    t.true(scheduler === role.scheduler)
    t.true(typeof handleMessage === 'function')
    t.true(receivedCrashHandler === crashHandler)
  })

  test(`input consumer calls handleMessage() on the ${type} when it reads a message`, t => {
    const { [type]: role, peers: [peer] } = t.context
    // Ensure message can be read
    const message = Symbol()
    peer.messages.take.onCall(0).returns(message)
    peer.messages.canTake.onCall(0).returns(true)

    const handleMessage = stub(role, 'handleMessage')
    role.inputConsumer.start()

    t.true(handleMessage.calledOnce)
    t.true(handleMessage.calledOn(role))
    const { args: [receivedPeer, handledMessage] } = handleMessage.firstCall
    t.true(receivedPeer === peer)
    t.true(handledMessage === message)
  })
}

function testInputConsumerStart (type) {
  test('start() starts the input consumer', t => {
    const { [type]: role } = t.context
    spy(role.inputConsumer, 'start')
    role.start()
    t.true(role.inputConsumer.start.calledOnce)
  })
}

function testMessageHandlerMapping (type, mapping) {
  for (const { type: messageType, label, method } of mapping) {
    test(`handleMessage() calls ${method}() with the peer, the message’s term, and the message itself, if the message type is ${label}`, t => {
      const { [type]: role, peers: [peer] } = t.context
      const methodStub = stub(role, method)
      const message = { type: messageType, term: 1 }
      role.handleMessage(peer, message)

      t.true(methodStub.calledOnce)
      const { args: [mappedPeer, mappedTerm, mappedMessage] } = methodStub.firstCall
      t.true(mappedPeer === peer)
      t.true(mappedTerm === message.term)
      t.true(mappedMessage === message)
    })

    test(`handleMessage() returns the result of calling ${method}()`, t => {
      const { [type]: role, peers: [peer] } = t.context
      const result = Symbol()
      stub(role, method).returns(result)
      t.true(role.handleMessage(peer, { type: messageType, term: 1 }) === result)
    })
  }

  test('handleMessage() ignores unknown message types', t => {
    const { [type]: role, peers: [peer] } = t.context
    t.true(role.handleMessage(peer, { type: Symbol(), term: 1 }) === undefined)
  })
}

function testSchedulerDestruction (type) {
  test('destroy() aborts the scheduler', t => {
    const { [type]: role } = t.context
    spy(role.scheduler, 'abort')
    role.destroy()
    t.true(role.scheduler.abort.calledOnce)
  })
}

function testSchedulerInstantiation (type) {
  test('instantiate a scheduler', t => {
    const { [type]: role, crashHandler, Scheduler } = t.context

    t.true(role.scheduler instanceof ActualScheduler)
    t.true(Scheduler.calledOnce)
    const { args: [receivedCrashHandler] } = Scheduler.firstCall
    t.true(receivedCrashHandler === crashHandler)
  })
}

Object.assign(exports, {
  setupConstructors,
  testFollowerConversion,
  testInputConsumerDestruction,
  testInputConsumerInstantiation,
  testInputConsumerStart,
  testMessageHandlerMapping,
  testSchedulerDestruction,
  testSchedulerInstantiation
})
