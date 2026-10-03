/** Stores are keyed case- and accent-insensitively ("Café X®" ≈ "cafe x"). */
export function storeKey(store: string): string {
  return store
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[®™]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
