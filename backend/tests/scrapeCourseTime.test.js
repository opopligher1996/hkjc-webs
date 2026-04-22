/**
 * Tests for scrapeCourseTime RSC payload parsing via parseCourseTimePayload()
 */
const { parseCourseTimePayload } = require('../src/scrapers/parsers');

// ── Helpers ────────────────────────────────────────────────────────────────
function buildPayload(pageData) {
  // Simulate RSC format: "ab:<json>\n" on a single line
  return `ab:${JSON.stringify(pageData)}\n`;
}

// Minimal standardSectionalData section
function stSection(anchor, distances) {
  return {
    anchor: { value: anchor },
    children: distances.map(({ dist, classes }) => ({
      distance: { value: String(dist) },
      children: classes.map(cls => ({
        class: {
          targetItem: {
            optionValue: { value: cls.code },
            displayLabel: { value: cls.label },
          }
        },
        standardTimes: { value: cls.stdTime },
        start2000M: { value: cls.s2000 || null },
        start201600M: { value: cls.s20001600 || null },
        start161200M: { value: cls.s16001200 || null },
        start12800M: { value: cls.s12800 || null },
        start8400M: { value: cls.s8400 || null },
        start400M: { value: cls.s400 || null },
      }))
    }))
  };
}

// Minimal classRecordData section
function recSection(displayTitle, distances) {
  return {
    displayTitle: { value: displayTitle },
    children: distances.map(({ dist, records }) => ({
      distance: { value: String(dist) },
      children: records.map(r => ({
        class: { value: String(r.class) },
        horseName: { value: r.horse },
        time: { value: r.time },
        weight: { value: r.weight || null },
        date: { dateValue: r.dateMs || null },
      }))
    }))
  };
}

describe('parseCourseTimePayload', () => {
  describe('sectionalData', () => {
    test('parses ST TURF section from StandardSectionalST anchor', () => {
      const payload = buildPayload({
        sectionalData: {
          children: [stSection('StandardSectionalST', [
            { dist: 1200, classes: [{ code: 'Class1', label: '第一班', stdTime: '1.08.45' }] }
          ])]
        },
        classRecordData: { children: [] }
      });
      const { courseTimes } = parseCourseTimePayload(payload);
      expect(courseTimes).toHaveLength(1);
      expect(courseTimes[0].racecourse).toBe('ST');
      expect(courseTimes[0].trackType).toBe('TURF');
      expect(courseTimes[0].distance).toBe(1200);
      expect(courseTimes[0].raceClass).toBe('第一班');
      expect(courseTimes[0].standardTime).toBe('1.08.45');
    });

    test('parses HV TURF section from StandardSectionalHV anchor', () => {
      const payload = buildPayload({
        sectionalData: {
          children: [stSection('StandardSectionalHV', [
            { dist: 1000, classes: [{ code: 'Class2', label: '第二班', stdTime: '0.58.20' }] }
          ])]
        },
        classRecordData: { children: [] }
      });
      const { courseTimes } = parseCourseTimePayload(payload);
      expect(courseTimes[0].racecourse).toBe('HV');
      expect(courseTimes[0].trackType).toBe('TURF');
    });

    test('parses ST AWT section from StandardSectionalSTAW anchor', () => {
      const payload = buildPayload({
        sectionalData: {
          children: [stSection('StandardSectionalSTAW', [
            { dist: 1650, classes: [{ code: 'Class3', label: '第三班', stdTime: '1.39.00' }] }
          ])]
        },
        classRecordData: { children: [] }
      });
      const { courseTimes } = parseCourseTimePayload(payload);
      expect(courseTimes[0].racecourse).toBe('ST');
      expect(courseTimes[0].trackType).toBe('AWT');
    });

    test('skips entries with empty or dash standard time', () => {
      const payload = buildPayload({
        sectionalData: {
          children: [stSection('StandardSectionalST', [
            { dist: 1000, classes: [
              { code: 'Class4', label: '第四班', stdTime: '-' },
              { code: 'Class5', label: '第五班', stdTime: '' },
              { code: 'Class1', label: '第一班', stdTime: '0.56.50' },
            ]}
          ])]
        },
        classRecordData: { children: [] }
      });
      const { courseTimes } = parseCourseTimePayload(payload);
      expect(courseTimes).toHaveLength(1);
      expect(courseTimes[0].raceClass).toBe('第一班');
    });

    test('includes split times when present', () => {
      const payload = buildPayload({
        sectionalData: {
          children: [stSection('StandardSectionalST', [
            { dist: 2000, classes: [{
              code: 'Class1', label: '第一班', stdTime: '2.03.00',
              s2000: null, s20001600: '0.25.00', s16001200: '0.24.50',
              s12800: '0.24.30', s8400: '0.24.20', s400: '0.24.00',
            }]}
          ])]
        },
        classRecordData: { children: [] }
      });
      const { courseTimes } = parseCourseTimePayload(payload);
      expect(courseTimes[0].split20001600).toBe('0.25.00');
      expect(courseTimes[0].split400Finish).toBe('0.24.00');
      expect(courseTimes[0].splitStart2000).toBeNull();
    });

    test('returns empty array when no sectionalData found', () => {
      const { courseTimes } = parseCourseTimePayload('nothing here\n');
      expect(courseTimes).toEqual([]);
    });
  });

  describe('classRecordData', () => {
    test('parses ST TURF records (default)', () => {
      const payload = buildPayload({
        sectionalData: { children: [] },
        classRecordData: {
          children: [recSection('沙田草地', [
            { dist: 1200, records: [{ class: '1', horse: '嘉應高昇', time: '1.08.45', weight: '133', dateMs: 1700000000000 }] }
          ])]
        }
      });
      const { courseRecords } = parseCourseTimePayload(payload);
      expect(courseRecords).toHaveLength(1);
      expect(courseRecords[0].racecourse).toBe('ST');
      expect(courseRecords[0].trackType).toBe('TURF');
      expect(courseRecords[0].horseName).toBe('嘉應高昇');
      expect(courseRecords[0].recordTime).toBe('1.08.45');
      expect(courseRecords[0].weight).toBe('133');
    });

    test('parses HV TURF records when title contains 跑馬地', () => {
      const payload = buildPayload({
        sectionalData: { children: [] },
        classRecordData: {
          children: [recSection('跑馬地草地', [
            { dist: 1000, records: [{ class: '2', horse: '快馬', time: '0.57.00', dateMs: 1700000000000 }] }
          ])]
        }
      });
      const { courseRecords } = parseCourseTimePayload(payload);
      expect(courseRecords[0].racecourse).toBe('HV');
    });

    test('parses ST AWT records when title contains 全天候', () => {
      const payload = buildPayload({
        sectionalData: { children: [] },
        classRecordData: {
          children: [recSection('沙田全天候跑道', [
            { dist: 1650, records: [{ class: '3', horse: '長跑馬', time: '1.39.00', dateMs: 1700000000000 }] }
          ])]
        }
      });
      const { courseRecords } = parseCourseTimePayload(payload);
      expect(courseRecords[0].racecourse).toBe('ST');
      expect(courseRecords[0].trackType).toBe('AWT');
    });

    test('converts dateMs to ISO date string', () => {
      const dateMs = new Date('2023-11-15').getTime();
      const payload = buildPayload({
        sectionalData: { children: [] },
        classRecordData: {
          children: [recSection('沙田草地', [
            { dist: 1200, records: [{ class: '1', horse: '馬名', time: '1.08.00', dateMs }] }
          ])]
        }
      });
      const { courseRecords } = parseCourseTimePayload(payload);
      expect(courseRecords[0].recordDate).toBe('2023-11-15');
    });

    test('null recordDate when dateValue is null', () => {
      const payload = buildPayload({
        sectionalData: { children: [] },
        classRecordData: {
          children: [recSection('沙田草地', [
            { dist: 1200, records: [{ class: '1', horse: '馬名', time: '1.08.00', dateMs: null }] }
          ])]
        }
      });
      const { courseRecords } = parseCourseTimePayload(payload);
      expect(courseRecords[0].recordDate).toBeNull();
    });
  });

  describe('nested data (pageData not at top level)', () => {
    test('finds sectionalData nested inside another key', () => {
      const payload = buildPayload({
        someWrapper: {
          deepData: {
            sectionalData: {
              children: [stSection('StandardSectionalST', [
                { dist: 1000, classes: [{ code: 'Class1', label: '第一班', stdTime: '0.56.50' }] }
              ])]
            },
            classRecordData: { children: [] }
          }
        }
      });
      const { courseTimes } = parseCourseTimePayload(payload);
      expect(courseTimes).toHaveLength(1);
    });
  });
});
