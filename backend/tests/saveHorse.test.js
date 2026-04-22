/**
 * Tests for saveHorse() DB operations.
 * Mocks the pg pool so no real DB connection is needed.
 */

// Mock the pool module before requiring hkjc.js
jest.mock('../src/db/pool', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
}));

const pool = require('../src/db/pool');
const { saveHorse } = require('../src/scrapers/hkjc');

beforeEach(() => {
  pool.query.mockClear();
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('saveHorse', () => {
  const horseId = 'HK_2023_J062';
  const fullInfo = {
    name_zh: '嘉應高昇',
    origin: '紐西蘭',
    age: 5,
    color: '棗',
    sex: '閹',
    wins: 20,
    seconds: 2,
    thirds: 0,
    total_starts: 22,
    trainer_id: 'HDA',
    owner: '嘉應堂',
    current_rating: 88,
    season_rating: 85,
    sire: 'Savabeel',
    dam: 'High Esteem',
  };

  test('calls pool.query exactly once', async () => {
    await saveHorse(horseId, fullInfo);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('uses INSERT ... ON CONFLICT DO UPDATE', async () => {
    await saveHorse(horseId, fullInfo);
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO horses/i);
    expect(sql).toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/DO UPDATE/i);
  });

  test('passes horseId as first parameter', async () => {
    await saveHorse(horseId, fullInfo);
    const params = pool.query.mock.calls[0][1];
    expect(params[0]).toBe(horseId);
  });

  test('passes name_zh as second parameter', async () => {
    await saveHorse(horseId, fullInfo);
    const params = pool.query.mock.calls[0][1];
    expect(params[1]).toBe('嘉應高昇');
  });

  test('passes null for missing optional fields', async () => {
    const sparse = { name_zh: '測試馬', wins: null, trainer_id: null };
    await saveHorse(horseId, sparse);
    const params = pool.query.mock.calls[0][1];
    // trainer_id is param index 10
    expect(params[10]).toBeNull();
  });

  test('does not throw if pool.query rejects (logs error instead)', async () => {
    pool.query.mockRejectedValue(new Error('DB error'));
    // saveHorse catches errors internally; should not throw
    await expect(saveHorse(horseId, fullInfo)).resolves.toBeUndefined();
  });
});
