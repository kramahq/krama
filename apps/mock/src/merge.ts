export const deepMerge = <T extends Record<string, any>>(
  base: T,
  patch: Record<string, any>,
): T => {
  for (const [k, v] of Object.entries(patch)) {
    base[k as keyof T] = (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof base[k] === 'object' &&
      base[k] !== null
        ? deepMerge(base[k], v)
        : v
    ) as T[keyof T];
  }
  return base;
};
