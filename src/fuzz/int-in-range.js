export default function intInRange (range) {
  const [min, max] = range
  const diff = max - min
  return (Math.random() * diff >> 0) + min
}
