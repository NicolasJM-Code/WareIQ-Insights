import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLegacyReports, readLegacyReports } from './legacy-report-import';

const report = { id: 'legacy-id', section: 'inbound', name: 'Receipts', description: 'My columns',
  dataset: 'receipts', fields: ['supplier', 'id'], createdAt: '2025-01-01', updatedAt: '2025-01-02' };
const encode = (reports: unknown[]) => JSON.stringify({ version: 1, reports });

test('valid legacy definitions retain column order, but not old IDs or ownership', () => {
  const original = encode([{ ...report, ownerId: 'not-proof', clientId: 'not-proof', rows: [{ secret: 1 }] }]);
  const parsed = parseLegacyReports(original);
  assert.equal(parsed.invalid, 0);
  assert.deepEqual(parsed.candidates[0], { index: 0, input: {
    section: 'inbound', name: 'Receipts', description: 'My columns', dataset: 'receipts', fields: ['supplier', 'id'],
  } });
  assert.equal(parseLegacyReports(original).candidates.length, 1, 'Parsing does not consume originals');
});
test('missing optional legacy properties use the original format defaults', () => {
  const { description: _description, ...old } = report;
  assert.equal(parseLegacyReports(encode([old])).candidates[0].input.description, '');
  assert.equal(parseLegacyReports(encode([{ ...old, sourceDefault: 'inbound-1' }])).candidates[0].input.sourceDefault, 'inbound-1');
});
test('malformed definitions are counted without blocking readable neighbours', () => {
  const bad = [null, 5, {}, { ...report, fields: ['id', 'id'] }, { ...report, fields: [null] },
    { ...report, description: {} }, { ...report, name: ' ' }, { ...report, sourceDefault: {} },
    { ...report, fields: [] }, { ...report, createdAt: undefined }];
  const parsed = parseLegacyReports(encode([...bad, report]));
  assert.equal(parsed.invalid, bad.length);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].index, bad.length);
});
test('corrupt and unknown formats are reported without attempting recovery', () => {
  for (const raw of ['broken JSON', 'null', '[]', JSON.stringify({ version: 2, reports: [report] }),
    JSON.stringify({ version: 1, reports: {} })]) {
    const parsed = parseLegacyReports(raw);
    assert.ok(parsed.error);
    assert.deepEqual(parsed.candidates, []);
  }
  assert.deepEqual(parseLegacyReports(null), { candidates: [], invalid: 0 });
});
test('oversized storage is rejected safely', () => {
  assert.ok(parseLegacyReports('x'.repeat(2_000_001)).error);
  assert.ok(parseLegacyReports(encode(Array(1001).fill(report))).error);
});
test('storage is read only on explicit request and never written or cleared', () => {
  let reads = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem(key: string) { reads++; assert.equal(key, 'wareiq.own-reports'); return encode([report]); },
    setItem() { assert.fail('Must not mutate legacy storage'); },
    removeItem() { assert.fail('Must not remove legacy storage'); },
  } } });
  assert.equal(reads, 0);
  assert.equal(readLegacyReports().candidates.length, 1);
  assert.equal(reads, 1);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { get localStorage() { throw new Error('Blocked'); } } });
  assert.match(readLegacyReports().error!, /blocked or unavailable/);
  Reflect.deleteProperty(globalThis, 'window');
});
