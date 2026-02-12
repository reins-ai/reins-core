export function generateId(prefix?: string): string {
  const id = crypto.randomUUID();

  if (!prefix) {
    return id;
  }

  return `${prefix}_${id}`;
}
