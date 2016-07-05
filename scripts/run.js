'use strict'

// Hook up source map support to rewrite stack traces.
require('source-map-support').install({
  environment: 'node',
  handleUncaughtExceptions: false
})

require('../dist/fuzz/run')
