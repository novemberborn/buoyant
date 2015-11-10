// Types for the AppendEntries RPC and success / failure replies.
export const AppendEntries = Symbol('AppendEntries')
export const AcceptEntries = Symbol('AcceptEntries')
export const RejectEntries = Symbol('RejectEntries')

// Types for the RequestVote RPC and success / failure replies.
export const RequestVote = Symbol('RequestVote')
export const DenyVote = Symbol('DenyVote')
export const GrantVote = Symbol('GrantVote')

// Value of a no-op entry.
export const Noop = Symbol('Noop')
