import { Effect, Exit } from 'effect';

/**
 * Wraps an effect factory so concurrent callers share one run. The first
 * caller's arguments start the run; a caller that arrives while it is in
 * flight waits for it and receives the same exit, and its own arguments are
 * ignored. Once the run settles, the next call starts a fresh one.
 */
export const singleFlight = <Args extends unknown[], A, E>(
  make: (...args: Args) => Effect.Effect<A, E>,
): ((...args: Args) => Effect.Effect<A, E>) => {
  let inFlight: Promise<Exit.Exit<A, E>> | undefined;
  return (...args) =>
    Effect.suspend(() => {
      let run = inFlight;
      if (!run) {
        const started = Effect.runPromiseExit(make(...args));
        run = inFlight = started;
        void started.finally(() => {
          if (inFlight === started) inFlight = undefined;
        });
      }
      const joined = run;
      return Effect.flatten(Effect.promise(() => joined));
    });
};
