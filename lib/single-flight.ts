import { Effect, Exit } from 'effect';

/**
 * Wraps an effect so concurrent callers share one run. A caller that arrives
 * while a run is in flight waits for it and receives the same exit; once it
 * settles, the next call starts a fresh run.
 */
export const singleFlight = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> => {
  let inFlight: Promise<Exit.Exit<A, E>> | undefined;
  return Effect.suspend(() => {
    if (!inFlight) {
      const run = Effect.runPromiseExit(effect);
      inFlight = run;
      void run.finally(() => {
        if (inFlight === run) inFlight = undefined;
      });
    }
    return Effect.flatten(Effect.promise(() => inFlight!));
  });
};
