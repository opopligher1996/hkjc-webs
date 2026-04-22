/**
 * Tests for saveCourseTime() DB operations.
 * Mocks the pg pool so no real DB connection is needed.
 */

jest.mock('../src/db/pool', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
}));

const pool = require('../src/db/pool');
const { saveCourseTime } = require('../src/scrapers/hkjc');

beforeEach(() => {
  pool.query.mockClear();
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
});

const sampleCourseTime = {
  section: 'StandardSectionalST',
  racecourse: 'ST',
  trackType: 'TURF',
  distance: 1200,
  raceClass: '第一班',
  standardTime: '1.08.45',
  splitStart2000: null,
  split20001600: null,
  split16001200: null,
  split12008000: null,
  split8004000: null,
  split400Finish: null,
};

const sampleCourseRecord = {
  racecourse: 'ST',
  trackType: 'TURF',
  distance: 1200,
  raceClass: '1',
  horseName: '嘉應高昇',
  recordTime: '1.08.45',
  weight: '133',
  recordDate: '2023-11-15',
};

describe('saveCourseTime', () => {
  test('inserts one course_times row and one course_records row', async () => {
    await saveCourseTime({ courseTimes: [sampleCourseTime], courseRecords: [sampleCourseRecord] });
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  test('course_times INSERT uses correct table name', async () => {
    await saveCourseTime({ courseTimes: [sampleCourseTime], courseRecords: [] });
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO course_times/i);
    expect(sql).toMatch(/ON CONFLICT/i);
  });

  test('course_records INSERT uses correct table name', async () => {
    await saveCourseTime({ courseTimes: [], courseRecords: [sampleCourseRecord] });
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO course_records/i);
    expect(sql).toMatch(/ON CONFLICT/i);
  });

  test('returns total count of saved rows', async () => {
    const saved = await saveCourseTime({
      courseTimes: [sampleCourseTime, sampleCourseTime],
      courseRecords: [sampleCourseRecord],
    });
    expect(saved).toBe(3);
  });

  test('returns 0 when both arrays are empty', async () => {
    const saved = await saveCourseTime({ courseTimes: [], courseRecords: [] });
    expect(saved).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('course_times params include section, racecourse, trackType, distance, raceClass', async () => {
    await saveCourseTime({ courseTimes: [sampleCourseTime], courseRecords: [] });
    const params = pool.query.mock.calls[0][1];
    expect(params[0]).toBe('StandardSectionalST');   // section
    expect(params[1]).toBe('ST');                     // racecourse
    expect(params[2]).toBe('TURF');                   // trackType
    expect(params[3]).toBe(1200);                     // distance
    expect(params[4]).toBe('第一班');                 // raceClass
    expect(params[5]).toBe('1.08.45');               // standardTime
  });

  test('course_records params include racecourse, distance, raceClass, horseName, time', async () => {
    await saveCourseTime({ courseTimes: [], courseRecords: [sampleCourseRecord] });
    const params = pool.query.mock.calls[0][1];
    expect(params[0]).toBe('ST');
    expect(params[2]).toBe(1200);
    expect(params[3]).toBe('1');
    expect(params[4]).toBe('嘉應高昇');
    expect(params[5]).toBe('1.08.45');
  });

  test('does not throw if pool.query rejects for a row (continues)', async () => {
    pool.query
      .mockRejectedValueOnce(new Error('constraint'))
      .mockResolvedValue({ rows: [], rowCount: 1 });

    const saved = await saveCourseTime({
      courseTimes: [sampleCourseTime, sampleCourseTime],
      courseRecords: [],
    });
    // First insert failed (caught), second succeeded
    expect(saved).toBe(1);
  });
});
