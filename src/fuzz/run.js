import Configuration from './Configuration'
import Reporter from './Reporter'
import Runner from './Runner'

const reporter = new Reporter({
  // TODO: Replace basic argument detection with yargs
  colors: process.argv.indexOf('--no-color') === -1,
  json: process.argv.indexOf('--json') !== -1
})

const configuration = new Configuration({
  // TODO: Make the various options configurable via command line arguments
  clusterSize: 5,
  reporter
})

const runner = new Runner({
  configuration,
  reporter
})

reporter.observeRun(runner.run())
process.on('unhandledRejection', err => reporter.unhandledRejection(err))
