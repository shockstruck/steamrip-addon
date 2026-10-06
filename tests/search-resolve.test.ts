import { describe, it, expect } from 'bun:test';
import { Effect } from 'effect';
import { resolveSearchAlways } from '../lib/search-resolve';

const run = async (effect: Effect.Effect<string[], unknown>) => {
  const resolved: string[][] = [];
  const causes: unknown[] = [];
  await Effect.runPromise(
    resolveSearchAlways(effect, {
      resolve: res => resolved.push(res),
      onCause: cause => causes.push(cause),
    }),
  );
  return { resolved, causes };
};

describe('resolveSearchAlways', () => {
  it('resolves the result on success', async () => {
    const { resolved, causes } = await run(Effect.succeed(['a']));
    expect(resolved).toEqual([['a']]);
    expect(causes).toHaveLength(0);
  });

  it('resolves [] on a typed failure', async () => {
    const { resolved, causes } = await run(Effect.fail(new Error('typed')));
    expect(resolved).toEqual([[]]);
    expect(causes).toHaveLength(1);
  });

  it('resolves [] when the effect dies with a defect', async () => {
    const { resolved, causes } = await run(
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          throw new Error('defect from a plain throw');
        });
        return ['never'];
      }),
    );
    expect(resolved).toEqual([[]]);
    expect(causes).toHaveLength(1);
  });

  it('resolves [] when a refresh dies with a defect', async () => {
    const { resolved } = await run(Effect.dieMessage('refresh died'));
    expect(resolved).toEqual([[]]);
  });
});
