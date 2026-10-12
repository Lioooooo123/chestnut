/**
 * Share one cleanup attempt among every caller. A call is never considered
 * complete merely because another caller started it. Retain verified success;
 * permit an explicit retry after failure, while every concurrent caller sees
 * that attempt's rejection.
 */
export function sharedVerifiedCleanup(operation: () => Promise<void>): () => Promise<void> {
  let attempt: Promise<void> | undefined;
  return (): Promise<void> => {
    if (!attempt) {
      attempt = Promise.resolve().then(operation).catch((error: unknown) => {
        attempt = undefined;
        throw error;
      });
    }
    return attempt;
  };
}
