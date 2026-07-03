import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from './env.js';

/** Minimum required keys post-BE-013 (INTERNAL_API_TOKEN is mandatory). */
const base = { TRADING_MODE: 'paper', INTERNAL_API_TOKEN: 'test-internal-token-16ch' };

describe('BE-002 env loader', () => {
  it('parses a valid environment with defaults', () => {
    const env = loadEnv({ ...base });
    expect(env.TRADING_MODE).toBe('paper');
    expect(env.API_PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['http://localhost:3000']);
    expect(env.RATE_LIMIT_MAX).toBe(100);
  });

  it('splits CORS_ALLOWED_ORIGINS and rejects short INTERNAL_API_TOKEN', () => {
    const env = loadEnv({ ...base, CORS_ALLOWED_ORIGINS: 'http://a.test, http://b.test' });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit called');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadEnv({ ...base, INTERNAL_API_TOKEN: 'short' })).toThrow('exit called');
    exit.mockRestore();
  });

  it('exits fast with a clear error list when TRADING_MODE is missing or invalid', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit called');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadEnv({})).toThrow('exit called');
    expect(() => loadEnv({ ...base, TRADING_MODE: 'demo' })).toThrow('exit called');
    expect(error).toHaveBeenCalled();
    exit.mockRestore();
    error.mockRestore();
  });

  it('coerces API_PORT and rejects nonsense', () => {
    expect(loadEnv({ ...base, TRADING_MODE: 'backtest', API_PORT: '4100' }).API_PORT).toBe(4100);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit called');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadEnv({ ...base, API_PORT: 'abc' })).toThrow('exit called');
    exit.mockRestore();
  });
});
