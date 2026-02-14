function assertSameLength(a: Float32Array, b: Float32Array): void {
  if (a.length !== b.length) {
    throw new RangeError(`Vector length mismatch: ${a.length} !== ${b.length}`);
  }
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
  assertSameLength(a, b);

  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }

  return sum;
}

export function magnitude(v: Float32Array): number {
  let sumSquares = 0;
  for (let index = 0; index < v.length; index += 1) {
    const value = v[index] ?? 0;
    sumSquares += value * value;
  }

  return Math.sqrt(sumSquares);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const product = dotProduct(a, b);
  const denominator = magnitude(a) * magnitude(b);

  if (denominator === 0) {
    return 0;
  }

  const similarity = product / denominator;
  if (similarity < -1) {
    return -1;
  }

  if (similarity > 1) {
    return 1;
  }

  return similarity;
}
