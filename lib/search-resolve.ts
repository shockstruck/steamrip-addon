import { Cause, Effect } from 'effect';

/**
 * Runs a search effect and always calls `resolve`, even when the effect fails
 * or dies with a defect. OGI polls a deferred search forever if it is never
 * resolved, so every exit path must answer.
 */
export const resolveSearchAlways = <A>(
  effect: Effect.Effect<A[], unknown>,
  handlers: {
    resolve: (res: A[]) => void;
    onCause?: (cause: Cause.Cause<unknown>) => void;
  },
): Effect.Effect<void> =>
  effect.pipe(
    Effect.catchAllCause(cause =>
      Effect.sync(() => {
        handlers.onCause?.(cause);
        return [] as A[];
      }),
    ),
    Effect.andThen(res => Effect.sync(() => handlers.resolve(res))),
  );
