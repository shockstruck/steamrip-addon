import { describe, it, expect } from 'bun:test';
import { Effect } from 'effect';
import { singleFlight } from '../lib/single-flight';

describe('singleFlight', () => {
  it('runs the effect once for concurrent callers', async () => {
    let runs = 0;
    const refresh = singleFlight(
      Effect.promise(async () => {
        runs++;
        await new Promise(r => setTimeout(r, 20));
        return 'done';
      }),
    );
    const results = await Effect.runPromise(
      Effect.all([refresh, refresh], { concurrency: 'unbounded' }),
    );
    expect(results).toEqual(['done', 'done']);
    expect(runs).toBe(1);
  });

  it('shares a failure with joiners and then allows a fresh run', async () => {
    let runs = 0;
    const refresh = singleFlight(
      Effect.suspend(() => {
        runs++;
        return runs === 1 ? Effect.fail('boom') : Effect.succeed('ok');
      }).pipe(Effect.delay('10 millis')),
    );
    const first = await Effect.runPromise(
      Effect.all([Effect.either(refresh), Effect.either(refresh)], { concurrency: 'unbounded' }),
    );
    expect(first.map(e => e._tag)).toEqual(['Left', 'Left']);
    expect(runs).toBe(1);
    expect(await Effect.runPromise(refresh)).toBe('ok');
    expect(runs).toBe(2);
  });

  it('shares a defect with joiners', async () => {
    const refresh = singleFlight(Effect.dieMessage('defect').pipe(Effect.delay('10 millis')));
    const exits = await Effect.runPromise(
      Effect.all([Effect.exit(refresh), Effect.exit(refresh)], { concurrency: 'unbounded' }),
    );
    expect(exits.every(e => e._tag === 'Failure')).toBe(true);
  });
});
