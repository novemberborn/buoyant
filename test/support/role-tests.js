import { before, beforeEach, context, it } from '!mocha'
import assert from 'power-assert'
import proxyquire from 'proxyquire'
import sinon from 'sinon'

import InputConsumer from '../../lib/InputConsumer'
import Scheduler from '../../lib/Scheduler'

export function setupConstructors (roleSource) {
  before(ctx => {
    ctx.InputConsumer = sinon.spy(function (...args) { return new InputConsumer(...args) })
    ctx.Scheduler = sinon.spy(function (...args) { return new Scheduler(...args) })

    const Role = proxyquire.noCallThru()(roleSource, {
      '../InputConsumer': function (...args) { return ctx.InputConsumer(...args) },
      '../Scheduler': function (...args) { return ctx.Scheduler(...args) }
    })['default']
    ctx[Role.name] = Role
  })

  beforeEach(ctx => {
    ctx.InputConsumer.reset()
    ctx.Scheduler.reset()
  })
}

export function testFollowerConversion (label, getRole) {
  context('the message’s term is newer', () => {
    beforeEach(ctx => {
      ctx.role = getRole(ctx)
      ctx.state._currentTerm.returns(1)
      ctx.message = { term: 2 }
    })

    it('sets the term to that of the message', ctx => {
      ctx.role.handleMessage(ctx.peer, ctx.message)
      sinon.assert.calledOnce(ctx.state.setTerm)
      sinon.assert.calledWithExactly(ctx.state.setTerm, 2)
    })

    it('returns a promise', ctx => {
      assert(ctx.role.handleMessage(ctx.peer, ctx.message) instanceof Promise)
    })

    context(`the ${label} was destroyed while persisting the state`, () => {
      it('does not convert to follower', async ctx => {
        let persisted
        ctx.state.setTerm.returns(new Promise(resolve => persisted = resolve))

        ctx.role.handleMessage(ctx.peer, ctx.message)
        ctx.role.destroy()
        persisted()

        await Promise.resolve()
        sinon.assert.notCalled(ctx.convertToFollower)
      })
    })

    context(`the ${label} was not destroyed while persisting the state`, () => {
      it('converts to follower', async ctx => {
        await ctx.role.handleMessage(ctx.peer, ctx.message)
        sinon.assert.calledOnce(ctx.convertToFollower)
        sinon.assert.calledWithMatch(ctx.convertToFollower, [sinon.match.same(ctx.peer), sinon.match.same(ctx.message)])
      })
    })
  })
}

export function testInputConsumerDestruction (getRole) {
  it('stops the input consumer', ctx => {
    const role = getRole(ctx)
    const spy = sinon.spy(role.inputConsumer, 'stop')
    role.destroy()
    sinon.assert.calledOnce(spy)
  })
}

export function testInputConsumerInstantiation (label, getRole, getCrashHandler) {
  it('instantiates an input consumer', ctx => {
    const role = getRole(ctx)

    assert(role.inputConsumer instanceof InputConsumer)
    sinon.assert.calledOnce(ctx.InputConsumer)
    const { args: [{ peers, nonPeerReceiver, scheduler, handleMessage, crashHandler }] } = ctx.InputConsumer.getCall(0)
    assert(peers === ctx.peers)
    assert(nonPeerReceiver === ctx.nonPeerReceiver)
    assert(scheduler === role.scheduler)
    assert(typeof handleMessage === 'function')
    assert(crashHandler === getCrashHandler(ctx))
  })

  context('a message is read by the input consumer', () => {
    it(`calls handleMessage on the ${label}`, ctx => {
      // Ensure message can be read
      const message = Symbol()
      ctx.peer.messages.take.onCall(0).returns(message)
      ctx.peer.messages.canTake.onCall(0).returns(true)

      const role = getRole(ctx)
      let handleMessage = sinon.stub(role, 'handleMessage')
      role.inputConsumer.start()

      sinon.assert.calledOnce(handleMessage)
      sinon.assert.calledOn(handleMessage, role)
      sinon.assert.calledWithExactly(handleMessage, ctx.peer, message)
    })
  })
}

export function testInputConsumerStart (getRole) {
  it('starts the input consumer', ctx => {
    const role = getRole(ctx)
    const spy = sinon.spy(role.inputConsumer, 'start')
    role.start()
    sinon.assert.calledOnce(spy)
  })
}

export function testMessageHandlerMapping (getRoleAndPeer, mapping) {
  mapping.forEach(({ type, label, method }) => {
    context(`the message type is ${label}`, () => {
      it(`calls ${method} with the peer, the message’s term, and the message itself`, ctx => {
        const [role, peer] = getRoleAndPeer(ctx)
        const stub = sinon.stub(role, method)
        const message = { type, term: 1 }
        role.handleMessage(peer, message)

        sinon.assert.calledOnce(stub)
        sinon.assert.calledWithExactly(stub, peer, message.term, message)
      })

      it(`returns the result of calling ${method}`, ctx => {
        const [role, peer] = getRoleAndPeer(ctx)
        const result = Symbol()
        sinon.stub(role, method).returns(result)
        assert(role.handleMessage(peer, { type, term: 1 }) === result)
      })
    })
  })

  context('the message type is unknown', () => {
    it('doesn’t do anything', ctx => {
      const [role, peer] = getRoleAndPeer(ctx)
      assert(role.handleMessage(peer, { type: Symbol(), term: 1 }) === undefined)
    })
  })
}

export function testSchedulerDestruction (getRole) {
  it('aborts the scheduler', ctx => {
    const role = getRole(ctx)
    const spy = sinon.spy(role.scheduler, 'abort')
    role.destroy()
    sinon.assert.calledOnce(spy)
  })
}

export function testSchedulerInstantiation (getRole, getCrashHandler) {
  it('instantiates a scheduler', ctx => {
    const role = getRole(ctx)

    assert(role.scheduler instanceof Scheduler)
    sinon.assert.calledOnce(ctx.Scheduler)
    const { args: [crashHandler] } = ctx.Scheduler.getCall(0)
    assert(crashHandler === getCrashHandler(ctx))
  })
}
