import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from './env.js';

describe('BE-002 env loader', () => {
  it('parses a valid environment with defaults', () => {
    const env = loadEnv({ TRADING_MODE: 'paper' });
    expect(env.TRADING_MODE).toBe('paper');
    expect(env.API_PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('exits fast with a clear error list when TRADING_MODE is missing or invalid', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit called');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadEnv({})).toThrow('exit called');
    expect(() => loadEnv({ TRADING_MODE: 'demo' })).toThrow('exit called');
    expect(error).toHaveBeenCalled();
    exit.mockRestore();
    error.mockRestore();
  });

  it('coerces API_PORT and rejects nonsense', () => {
    expect(loadEnv({ TRADING_MODE: 'backtest', API_PORT: '4100' }).API_PORT).toBe(4100);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit called');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadEnv({ TRADING_MODE: 'backtest', API_PORT: 'abc' })).toThrow('exit called');
    exit.mockRestore();
  });
});
