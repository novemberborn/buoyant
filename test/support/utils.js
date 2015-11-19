export function getReason (promise) {
  return promise.then(value => { throw value }, reason => reason)
}
