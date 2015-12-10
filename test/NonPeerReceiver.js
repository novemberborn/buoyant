import { before, beforeEach, context, describe, it } from '!mocha'
import assert from 'power-assert'
import proxyquire from 'proxyquire'
import { stub } from 'sinon'

import { getReason } from './support/utils'

describe('NonPeerReceiver', () => {
  before(ctx => {
    ctx.MessageBuffer = stub()
    ctx.Peer = stub()
    ctx.NonPeerReceiver = proxyquire.noCallThru()('../lib/NonPeerReceiver', {
      './MessageBuffer': function (...args) { return ctx.MessageBuffer(...args) },
      './Peer': function (...args) { return ctx.Peer(...args) }
    })['default']
  })

  beforeEach(ctx => {
    ctx.MessageBuffer.reset()
    ctx.Peer.reset()

    ctx.stream = stub({ read () {} })
    ctx.connect = stub().returns(new Promise(() => {}))
  })

  describe('constructor (stream, connect)', () => {
    it('creates a message buffer for the stream', ctx => {
      const messages = {}
      ctx.MessageBuffer.returns(messages)

      const receiver = new ctx.NonPeerReceiver(ctx.stream, ctx.connect)
      assert(ctx.MessageBuffer.calledOnce)
      const { args: [stream] } = ctx.MessageBuffer.firstCall
      assert(stream === ctx.stream)
      assert(receiver.messages === messages)
    })
  })

  describe('#createPeer (address)', ctx => {
    it('connects to the address', ctx => {
      const receiver = new ctx.NonPeerReceiver(ctx.stream, ctx.connect)
      const peerAddress = Symbol()
      receiver.createPeer(peerAddress)

      assert(ctx.connect.calledOnce)
      const { args: [{ address, writeOnly }] } = ctx.connect.firstCall
      assert(address === peerAddress)
      assert(writeOnly === true)
    })

    context('connecting succeeds', () => {
      it('returns a promise fulfilled with the peer', async ctx => {
        const peerAddress = Symbol()
        const stream = {}
        ctx.connect.returns(Promise.resolve(stream))

        const peer = {}
        ctx.Peer.returns(peer)

        const receiver = new ctx.NonPeerReceiver(ctx.stream, ctx.connect)
        assert(await receiver.createPeer(peerAddress) === peer)
        const { args: [addressForPeer, streamForPeer] } = ctx.Peer.lastCall
        assert(addressForPeer === peerAddress)
        assert(streamForPeer === stream)
      })
    })

    context('connecting fails', () => {
      it('returns a promise rejected with the failure', async ctx => {
        const err = Symbol()
        ctx.connect.returns(Promise.reject(err))

        const receiver = new ctx.NonPeerReceiver(ctx.stream, ctx.connect)
        assert(await getReason(receiver.createPeer()) === err)
      })
    })
  })
})
