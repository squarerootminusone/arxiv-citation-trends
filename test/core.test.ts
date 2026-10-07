import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arxivIdFromPath, arxivYear, bucketCitations, classifyTrend, fitYear, monthKey, niceMax, whittaker, yearFraction } from '../src/core.ts';

const OCT = new Date(Date.UTC(2026, 9, 7)); // ~77% through the year
const MAR = new Date(Date.UTC(2026, 2, 1)); // ~16% through the year

test('arxivIdFromPath handles new, versioned and old-style ids', () => {
  assert.equal(arxivIdFromPath('/abs/2010.08895'), '2010.08895');
  assert.equal(arxivIdFromPath('/abs/2010.08895v3'), '2010.08895');
  assert.equal(arxivIdFromPath('/abs/1706.03762v7/'), '1706.03762');
  assert.equal(arxivIdFromPath('/abs/hep-th/9901001v2'), 'hep-th/9901001');
  assert.equal(arxivIdFromPath('/abs/math.GT/0309136'), 'math.GT/0309136');
  assert.equal(arxivIdFromPath('/list/cs.LG/new'), null);
  assert.equal(arxivIdFromPath('/abs/not-an-id'), null);
});

test('arxivYear reads the submission year from the id', () => {
  assert.equal(arxivYear('2305.13301'), 2023);
  assert.equal(arxivYear('0704.0001'), 2007);
  assert.equal(arxivYear('hep-th/9901001'), 1999);
  assert.equal(arxivYear('math.GT/0309136'), 2003);
});

test('bucketCitations drops impossible years and buckets dated months', () => {
  const r = bucketCitations(
    [
      { year: 2021, publicationDate: '2021-03-01' }, // before the paper existed
      { year: 2024, publicationDate: '2024-02-10' },
      { year: 2024, publicationDate: null },
      { year: 2025, publicationDate: '2025-07-01' },
      { year: 2025, publicationDate: '2024-12-30' }, // date disagrees with year: count, but no month
      { year: null },
      { year: 2027 },
    ],
    2023,
    2026,
  );
  assert.deepEqual(r.counts, { 2024: 2, 2025: 2 });
  assert.deepEqual(r.months, { '2024-02': 1, '2025-07': 1 });
  assert.equal(r.excluded, 3);
});

test('yearFraction', () => {
  assert.equal(yearFraction(new Date(Date.UTC(2026, 0, 1))), 0);
  assert.ok(Math.abs(yearFraction(OCT) - 0.767) < 0.01);
});

test('whittaker of order 3 reproduces a quadratic exactly', () => {
  const y = Array.from({ length: 20 }, (_, i) => 3 + 2 * i + 0.5 * i * i);
  const z = whittaker(y, 1e4, 3);
  z.forEach((v, i) => assert.ok(Math.abs(v - y[i]!) < 1e-6));
});

function monthsFrom(rate: (i: number) => number, fromYear: number, toYear: number, toMonth: number) {
  const months: Record<string, number> = {};
  const counts: Record<number, number> = {};
  for (let i = fromYear * 12; i <= toYear * 12 + toMonth; i++) {
    const y = Math.floor(i / 12);
    const v = Math.round(rate(i - fromYear * 12));
    months[monthKey(y, i % 12)] = v;
    counts[y] = (counts[y] ?? 0) + v;
  }
  return { months, counts };
}

test('fitYear projects a steady rate to about 12 months of it', () => {
  // 50 a month through September 2026, observed on 7 Oct.
  const { months, counts } = monthsFrom(() => 50, 2023, 2026, 8);
  const fit = fitYear({ months, counts, capped: [], firstYear: 2023 }, OCT)!;
  assert.ok(Math.abs(fit.projected - 600) < 15, `projected ${fit.projected}`);
  assert.equal(fit.future.length, 3);
});

test('fitYear carries growth and decline forward', () => {
  const up = monthsFrom((i) => 10 + 2 * i, 2023, 2026, 8);
  const fu = fitYear({ ...up, capped: [], firstYear: 2023 }, OCT)!;
  const upYtd = up.counts[2026]!;
  assert.ok(fu.projected > upYtd + 3 * 90, 'growing rate projects above the last month rate');
  const down = monthsFrom((i) => Math.max(5, 200 - 4 * i), 2023, 2026, 8);
  const fd = fitYear({ ...down, capped: [], firstYear: 2023 }, OCT)!;
  assert.ok(fd.future[2]! < fd.future[0]!, 'declining rate keeps declining');
});

test('fitYear scales dated months up to the full year count', () => {
  const { months, counts } = monthsFrom(() => 50, 2023, 2026, 8);
  for (const y of [2023, 2024, 2025, 2026]) counts[y] = Math.round(counts[y]! * 1.25); // a fifth undated
  const fit = fitYear({ months, counts, capped: [], firstYear: 2023 }, OCT)!;
  assert.ok(Math.abs(fit.projected - 750) < 20, `projected ${fit.projected}`);
});

test('fitYear needs enough data and no capped years', () => {
  const few = monthsFrom(() => 1, 2026, 2026, 8);
  assert.equal(fitYear({ ...few, capped: [], firstYear: 2026 }, OCT), null);
  const big = monthsFrom(() => 50, 2023, 2026, 8);
  assert.equal(fitYear({ ...big, capped: [2026], firstYear: 2023 }, OCT), null);
});

test('with a projection, the trend compares it with last year', () => {
  const t = classifyTrend({ 2025: 1253, 2026: 1658 }, { now: OCT, pubYear: 2020, projected: 2256 });
  assert.equal(t.label, 'up');
  assert.equal(t.detail, '2026: ~2,256 projected, +80% on 2025');
  assert.equal(classifyTrend({ 2025: 100 }, { now: MAR, pubYear: 2018, projected: 60 }).label, 'down');
  assert.equal(classifyTrend({ 2025: 100 }, { now: MAR, pubYear: 2018, projected: 105 }).label, 'flat');
});

test('without a projection, late in the year the pace is used', () => {
  const t = classifyTrend({ 2025: 1253, 2026: 1658 }, { now: OCT, pubYear: 2020 });
  assert.equal(t.label, 'up');
  assert.equal(t.detail, '2026 pace: 2,169, +73% on 2025');
});

test('without a projection, early in the year the last two full years are compared', () => {
  const t = classifyTrend({ 2024: 50, 2025: 30, 2026: 1 }, { now: MAR, pubYear: 2019 });
  assert.equal(t.label, 'down');
  assert.equal(t.detail, '2025: 30, \u221240% on 2024');
});

test('tiny counts need an absolute change of 3 to move off flat', () => {
  assert.equal(classifyTrend({ 2024: 1, 2025: 2 }, { now: MAR, pubYear: 2020 }).label, 'flat');
  assert.equal(classifyTrend({ 2024: 1, 2025: 4 }, { now: MAR, pubYear: 2020 }).label, 'up');
});

test('papers too new or capped get no label', () => {
  assert.equal(classifyTrend({ 2026: 5 }, { now: OCT, pubYear: 2026, projected: 9 }).text, 'new paper');
  assert.equal(classifyTrend({ 2025: 5 }, { now: MAR, pubYear: 2025 }).text, 'too new');
  assert.equal(classifyTrend({ 2025: 9999, 2026: 9999 }, { now: OCT, pubYear: 2017, capped: [2025, 2026] }).text, 'trend n/a');
});

test('niceMax', () => {
  assert.deepEqual([0, 1, 3, 7, 12, 99, 101, 1253].map(niceMax), [1, 1, 5, 10, 20, 100, 200, 2000]);
});
