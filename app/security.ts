export function isResultAttachment(path: string, userId: string, resultId: string) {
  const prefix = `${userId}/${resultId}/`;
  return path.startsWith(prefix) && /^\d+\.docx?$/.test(path.slice(prefix.length));
}

export function randomIndex(length: number) {
  if (!Number.isInteger(length) || length < 1 || length > 0x100000000) throw new Error('Invalid pool size');
  const limit = Math.floor(0x100000000 / length) * length;
  let value: number;
  do { value = crypto.getRandomValues(new Uint32Array(1))[0]; } while (value >= limit);
  return value % length;
}

export function shuffled<T>(items: readonly T[]) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
