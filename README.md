# Buoyant

Buoyant's goal is to make it easier to build distributed systems that fit your
needs.

Servers in distributed systems need to agree with each other on their state.
Buoyant implements the [Raft Consensus Algorithm](https://raft.github.io), a
relatively understandable algorithm for ensuring all servers agree on their
state. This allows you to build a reliable, distributed system that fits your
needs. You get to decide how state is stored and how servers communicate with
each other. Eventually plugins will be available to make this even easier.

## Raft overview

Servers form a cluster. There is a single leader that is allowed to modify its
state. The other servers are followers and will replicate the leader's state. If
the leader crashes the followers automatically elect a new leader without losing
any data. A cluster of three servers can survive the loss of one and still
function. A cluster of five servers can lose two.

State is modified using deterministic commands that are applied in-order. The
leader replicates these commands to (at least half of) its followers before
applying them to its own state. Then the followers do the same. This ensures
that each server, eventually, has the same state as the leader.

[The Raft website has more details](https://raft.github.io).

## Is Buoyant production ready?

No. The 1.0 release will be the first production-ready version.

## Requirements

Buoyant requires at least [Node.js](https://nodejs.org) v6.2.2.

## Installation

```
npm install --save buoyant
```

## Roadmap

* Add proper error types for internal errors
* Implement a TCP transport plugin
* Implement a state persistence plugin
* Document the public API, implementation requirements, how to build custom
transports
* 1.0 release
* Support client interactions
* Support modifying the cluster
* Support snapshotting & log compaction
* Implement the leadership transfer extension
