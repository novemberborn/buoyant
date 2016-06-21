'use strict'

module.exports = function macro (implementation, title) {
  const macro = function (...args) {
    return implementation(...args)
  }
  macro.title = title
  return macro
}
