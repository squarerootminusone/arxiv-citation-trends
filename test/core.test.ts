import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arxivIdFromPath, bucketYears, classifyTrend, niceMax, yearFraction } from '../src/core.ts';

const OCT = new Date(Date.UTC(2026, 9, 7)); // ~77% through the year
const MAR = new Date(Date.UTC(2026, 2, 1)); // ~16% through the year

test('arxivIdFromPath handles new, versioned and old-style ids', () => {
  assert.equal(arxivIdFromPath('/abs/2010.08895'), '2010.08895');
  assert.equal(arxivIdFromPath('/abs/2010.08895v3'), '2010.08895');
  assert.equal(arxivIdFromPath('/abs/1706.03762v7/'), '1706.03762');
  assert.equal(arxivIdFromPath('/abs/0704.0001'), '0704.0001');
  assert.equal(arxivIdFromPath('/abs/hep-th/9901001v2'), 'hep-th/9901001');
  assert.equal(arxivIdFromPath('/abs/math.GT/0309136'), 'math.GT/0309136');
  assert.equal(arxivIdFromPath('/list/cs.LG/new'), null);
  assert.equal(arxivIdFromPath('/abs/not-an-id'), null);
});

test('bucketYears counts nulls and future years as undated', () => {
  const r = bucketYears([2024, 2024, 2025, null, undefined, 2027], 2026);
  assert.deepEqual(r.counts, { 2024: 2, 2025: 1 });
  assert.equal(r.undated, 3);
});

test('yearFraction', () => {
  assert.equal(yearFraction(new Date(Date.UTC(2026, 0, 1))), 0);
  assert.ok(Math.abs(yearFraction(OCT) - 0.767) < 0.01);
});

test('late in the year, this year pace is compared with last year', () => {
  // 1658 by 7 Oct annualises to ~2169 against 1253: up.
  const t = classifyTrend({ 2025: 1253, 2026: 1658 }, { now: OCT, pubYear: 2020 });
  assert.equal(t.label, 'up');
  assert.equal(t.text, 'trending up');
  assert.match(t.detail, /^2026 pace: 2169 vs 2025: 1253 \(\+73%\)$/);
});

test('steady pace is flat, a drop is down', () => {
  const steady = classifyTrend({ 2025: 100, 2026: 77 }, { now: OCT, pubYear: 2018 });
  assert.equal(steady.label, 'flat');
  const drop = classifyTrend({ 2025: 100, 2026: 40 }, { now: OCT, pubYear: 2018 });
  assert.equal(drop.label, 'down');
  assert.equal(drop.text, 'trending down');
});

test('early in the year, the last two full years are compared', () => {
  const t = classifyTrend({ 2024: 50, 2025: 30, 2026: 1 }, { now: MAR, pubYear: 2019 });
  assert.equal(t.label, 'down');
  assert.match(t.detail, /^2025: 30 vs 2024: 50/);
});

test('tiny counts need an absolute change of 3 to move off flat', () => {
  assert.equal(classifyTrend({ 2024: 1, 2025: 2 }, { now: MAR, pubYear: 2020 }).label, 'flat');
  assert.equal(classifyTrend({ 2024: 1, 2025: 4 }, { now: MAR, pubYear: 2020 }).label, 'up');
  assert.equal(classifyTrend({}, { now: MAR, pubYear: 2020 }).label, 'flat');
});

test('papers too new to compare get no label', () => {
  assert.equal(classifyTrend({ 2026: 5 }, { now: OCT, pubYear: 2026 }).label, null);
  assert.equal(classifyTrend({ 2025: 5 }, { now: MAR, pubYear: 2025 }).text, 'too new');
  // From July, last year's papers compare this year pace with their first year.
  assert.equal(classifyTrend({ 2025: 5, 2026: 30 }, { now: OCT, pubYear: 2025 }).label, 'up');
});

test('capped years give no label', () => {
  const t = classifyTrend({ 2025: 9999, 2026: 9999 }, { now: OCT, pubYear: 2017, capped: [2025, 2026] });
  assert.equal(t.label, null);
  assert.equal(t.text, 'trend n/a');
});

test('niceMax', () => {
  assert.deepEqual([0, 1, 3, 7, 12, 99, 101, 1253].map(niceMax), [1, 1, 5, 10, 20, 100, 200, 2000]);
});
