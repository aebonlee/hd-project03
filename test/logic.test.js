/**
 * logic.test.js — 순수 로직 단위 테스트
 * 실행: node test/logic.test.js
 */
'use strict';

var assert = require('assert');
var Logic = require('../js/logic.js');

var passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

console.log('\n[1] 사업자번호 정규화 / 포맷');
test('하이픈 포함 사업자번호를 숫자만으로 정규화한다', function () {
  assert.strictEqual(Logic.normalizeBizNo('123-45-67890'), '1234567890');
  assert.strictEqual(Logic.normalizeBizNo(' 123 45 67890 '), '1234567890');
  assert.strictEqual(Logic.normalizeBizNo(null), '');
});
test('10자리 사업자번호를 표준 형식으로 포맷한다', function () {
  assert.strictEqual(Logic.formatBizNo('1234567890'), '123-45-67890');
});

console.log('\n[2] 인증');
var vendors = [
  { bizNo: '1234567890', name: '대한테크', password: '1234' },
  { bizNo: '2345678901', name: '한빛물류', password: '5678' }
];
test('사업자번호 + 비밀번호가 일치하면 업체를 반환한다', function () {
  var v = Logic.authenticateVendor(vendors, '123-45-67890', '1234');
  assert.ok(v);
  assert.strictEqual(v.name, '대한테크');
});
test('비밀번호가 다르면 null을 반환한다', function () {
  assert.strictEqual(Logic.authenticateVendor(vendors, '1234567890', 'wrong'), null);
});
test('존재하지 않는 사업자번호는 null을 반환한다', function () {
  assert.strictEqual(Logic.authenticateVendor(vendors, '9999999999', '1234'), null);
});

console.log('\n[3] 권한 필터 (업체 간 데이터 격리)');
var items = [
  { id: 'IT-1', bizNo: '1234567890', name: '유압잭', qty: 10, unitPrice: 50000 },
  { id: 'IT-2', bizNo: '1234567890', name: '전동드릴', qty: 5, unitPrice: 120000 },
  { id: 'IT-3', bizNo: '2345678901', name: '용접기', qty: 3, unitPrice: 800000 }
];
test('본인 업체 아이템만 반환한다', function () {
  var mine = Logic.filterByVendor(items, '123-45-67890');
  assert.strictEqual(mine.length, 2);
  assert.ok(mine.every(function (i) { return i.bizNo === '1234567890'; }));
});
test('다른 업체 아이템은 절대 포함되지 않는다', function () {
  var mine = Logic.filterByVendor(items, '2345678901');
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].id, 'IT-3');
  assert.ok(!mine.some(function (i) { return i.bizNo === '1234567890'; }));
});
test('빈 사업자번호는 빈 배열을 반환한다', function () {
  assert.deepStrictEqual(Logic.filterByVendor(items, ''), []);
});

console.log('\n[4] 실사 라인 계산');
test('일치 라인: 차이 0, match=true', function () {
  var line = Logic.computeLine(items[0], 10);
  assert.strictEqual(line.diff, 0);
  assert.strictEqual(line.amountDiff, 0);
  assert.strictEqual(line.match, true);
});
test('부족 라인: 음수 차이와 금액차이 계산', function () {
  var line = Logic.computeLine(items[0], 8); // 장부 10, 단가 50000
  assert.strictEqual(line.diff, -2);
  assert.strictEqual(line.amountDiff, -100000);
  assert.strictEqual(line.match, false);
});
test('미입력 라인: diff/match가 null', function () {
  var line = Logic.computeLine(items[0], '');
  assert.strictEqual(line.actualQty, null);
  assert.strictEqual(line.diff, null);
  assert.strictEqual(line.match, null);
});
test('삭제 요청 라인: 실사수량 0으로 계산', function () {
  var line = Logic.computeLine(items[1], null, true); // 장부 5, 단가 120000
  assert.strictEqual(line.actualQty, 0);
  assert.strictEqual(line.diff, -5);
  assert.strictEqual(line.amountDiff, -600000);
  assert.strictEqual(line.deleteRequested, true);
});
test('음수/비정상 입력은 미입력으로 처리한다', function () {
  assert.strictEqual(Logic.computeLine(items[0], -3).actualQty, null);
  assert.strictEqual(Logic.computeLine(items[0], 'abc').actualQty, null);
});

console.log('\n[5] 제출 검증');
function makeLine(item, actual, reason, del) {
  var l = Logic.computeLine(item, actual, del);
  l.itemName = item.name;
  l.reason = reason;
  return l;
}
var att = { fileName: '확인서.pdf', size: 1024 };
test('모두 일치 + 첨부 있으면 제출 가능', function () {
  var r = Logic.validateSubmission([makeLine(items[0], 10), makeLine(items[1], 5)], att);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.errors.length, 0);
});
test('불일치인데 소명이 없으면 제출 차단', function () {
  var r = Logic.validateSubmission([makeLine(items[0], 8, '')], att);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].indexOf('소명') !== -1);
});
test('불일치 + 소명 입력 시 제출 가능', function () {
  var r = Logic.validateSubmission([makeLine(items[0], 8, '파손 2개 폐기')], att);
  assert.strictEqual(r.ok, true);
});
test('실사 수량 미입력 라인이 있으면 제출 차단', function () {
  var r = Logic.validateSubmission([makeLine(items[0], null)], att);
  assert.strictEqual(r.ok, false);
});
test('삭제 요청은 사유가 있어야 한다', function () {
  var noReason = Logic.validateSubmission([makeLine(items[1], null, '', true)], att);
  assert.strictEqual(noReason.ok, false);
  var withReason = Logic.validateSubmission([makeLine(items[1], null, '대여 종료(반납 완료)', true)], att);
  assert.strictEqual(withReason.ok, true);
});
test('확인서 첨부가 없으면 제출 차단', function () {
  var r = Logic.validateSubmission([makeLine(items[0], 10)], null);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].indexOf('첨부') !== -1);
});

console.log('\n[6] 첨부 파일 검증');
test('PDF/JPG/PNG는 허용', function () {
  assert.strictEqual(Logic.validateFile('scan.PDF', 1000).ok, true);
  assert.strictEqual(Logic.validateFile('photo.jpg', 1000).ok, true);
  assert.strictEqual(Logic.validateFile('photo.png', 1000).ok, true);
});
test('허용되지 않는 확장자는 거부', function () {
  assert.strictEqual(Logic.validateFile('macro.xlsx', 1000).ok, false);
  assert.strictEqual(Logic.validateFile('noext', 1000).ok, false);
});
test('10MB 초과 파일은 거부', function () {
  assert.strictEqual(Logic.validateFile('big.pdf', 10 * 1024 * 1024 + 1).ok, false);
  assert.strictEqual(Logic.validateFile('ok.pdf', 10 * 1024 * 1024).ok, true);
});

console.log('\n[7] 일치도 지표');
test('전량 일치 시 100%', function () {
  var lines = [makeLine(items[0], 10), makeLine(items[1], 5)];
  var r = Logic.computeMatchRates(lines);
  assert.strictEqual(r.qtyRate, 100);
  assert.strictEqual(r.amountRate, 100);
  assert.strictEqual(r.mismatchCount, 0);
});
test('수량/금액 일치도 계산식 검증', function () {
  // 장부: 10개×50,000 + 5개×120,000 = 1,100,000 / 총 15개
  // 실사: 8개(−2), 5개 → |차이수량| 2, |금액차이| 100,000
  var lines = [makeLine(items[0], 8, '소명'), makeLine(items[1], 5)];
  var r = Logic.computeMatchRates(lines);
  assert.strictEqual(r.qtyRate, Math.round((1 - 2 / 15) * 1000) / 10); // 86.7
  assert.strictEqual(r.amountRate, Math.round((1 - 100000 / 1100000) * 1000) / 10); // 90.9
  assert.strictEqual(r.mismatchCount, 1);
  assert.strictEqual(r.lineRate, 50);
});
test('삭제 요청 라인은 차이에 포함되고 deleteCount 집계', function () {
  var lines = [makeLine(items[0], 10), makeLine(items[1], null, '반납', true)];
  var r = Logic.computeMatchRates(lines);
  assert.strictEqual(r.deleteCount, 1);
  assert.strictEqual(r.totalDiffQty, 5);
  assert.strictEqual(r.mismatchCount, 1);
});
test('미입력 라인은 지표에서 제외', function () {
  var lines = [makeLine(items[0], 10), makeLine(items[1], null)];
  var r = Logic.computeMatchRates(lines);
  assert.strictEqual(r.countedLines, 1);
  assert.strictEqual(r.qtyRate, 100);
});
test('장부 수량 0이면 100%로 처리(0 나누기 방지)', function () {
  var r = Logic.computeMatchRates([]);
  assert.strictEqual(r.qtyRate, 100);
  assert.strictEqual(r.amountRate, 100);
});

console.log('\n[8] 제출 현황 분류');
var audits = [
  { id: 'AU-1', bizNo: '2345678901', round: '2026-08', status: '제출', submittedAt: '2026-08-10' },
  { id: 'AU-2', bizNo: '3456789012', round: '2026-08', status: '제출', submittedAt: '2026-08-11' },
  { id: 'AU-3', bizNo: '4567890123', round: '2026-08', status: '승인', submittedAt: '2026-08-09' },
  { id: 'AU-4', bizNo: '1234567890', round: '2026-08', status: '작성중' }
];
var auditLines = [
  { auditId: 'AU-1', diff: 0, deleteRequested: false, bookQty: 3, actualQty: 3, amountDiff: 0, bookAmount: 100 },
  { auditId: 'AU-2', diff: -1, deleteRequested: false, bookQty: 4, actualQty: 3, amountDiff: -10, bookAmount: 40 }
];
test('제출 이력이 없으면 미제출', function () {
  assert.strictEqual(Logic.vendorSubmissionStatus(audits, auditLines, '5678901234', '2026-08'), '미제출');
});
test('작성중 상태는 미제출로 분류', function () {
  assert.strictEqual(Logic.vendorSubmissionStatus(audits, auditLines, '1234567890', '2026-08'), '미제출');
});
test('전량 일치 제출은 제출', function () {
  assert.strictEqual(Logic.vendorSubmissionStatus(audits, auditLines, '2345678901', '2026-08'), '제출');
});
test('불일치 라인이 있으면 불일치 있음', function () {
  assert.strictEqual(Logic.vendorSubmissionStatus(audits, auditLines, '3456789012', '2026-08'), '불일치 있음');
});
test('승인 상태는 승인 완료', function () {
  assert.strictEqual(Logic.vendorSubmissionStatus(audits, auditLines, '4567890123', '2026-08'), '승인 완료');
});

console.log('\n[9] 대시보드 요약');
test('업체별 현황과 요약 집계가 맞다', function () {
  var vs = [
    { bizNo: '1234567890', name: 'A' },
    { bizNo: '2345678901', name: 'B' },
    { bizNo: '3456789012', name: 'C' },
    { bizNo: '4567890123', name: 'D' },
    { bizNo: '5678901234', name: 'E' }
  ];
  var d = Logic.buildDashboard(vs, audits, auditLines, '2026-08');
  assert.strictEqual(d.rows.length, 5);
  assert.deepStrictEqual(d.summary, { total: 5, notSubmitted: 2, submitted: 1, mismatch: 1, approved: 1 });
  var rowC = d.rows.find(function (r) { return r.vendorName === 'C'; });
  assert.strictEqual(rowC.mismatchCount, 1);
});

console.log('\n[10] 업체 임포트 분석');
var existingVendors = [
  { bizNo: '1234567890', name: '대한테크', password: '1234' },
  { bizNo: '2345678901', name: '한빛물류', password: '1234' }
];
test('신규 / 덮어씀을 사업자번호 기준으로 분류한다', function () {
  var r = Logic.analyzeVendorImport(existingVendors, [
    { bizNo: '123-45-67890', name: '대한테크(수정)', password: 'abcd' }, // 기존 → 덮어씀
    { bizNo: '9999999999', name: '신규상사', password: '5678' }          // 신규
  ]);
  assert.strictEqual(r.newCount, 1);
  assert.strictEqual(r.overwriteCount, 1);
  assert.strictEqual(r.duplicateInFileCount, 0);
  assert.strictEqual(r.vendors.length, 2);
});
test('파일 내 사업자번호 중복은 마지막 행이 우선하고 건수를 집계한다', function () {
  var r = Logic.analyzeVendorImport([], [
    { bizNo: '1111111111', name: '첫번째', password: 'a' },
    { bizNo: '111-11-11111', name: '두번째', password: 'b' }
  ]);
  assert.strictEqual(r.duplicateInFileCount, 1);
  assert.strictEqual(r.vendors.length, 1);
  assert.strictEqual(r.vendors[0].name, '두번째');
});
test('비밀번호 미입력 행은 기본값을 적용하고 건수를 보고한다', function () {
  var r = Logic.analyzeVendorImport([], [
    { bizNo: '1111111111', name: 'A', password: '' },
    { bizNo: '2222222222', name: 'B', password: '  ' },
    { bizNo: '3333333333', name: 'C', password: 'pw' }
  ]);
  assert.strictEqual(r.defaultPasswordCount, 2);
  assert.strictEqual(r.vendors[0].password, Logic.DEFAULT_VENDOR_PASSWORD);
  assert.strictEqual(r.vendors[1].password, Logic.DEFAULT_VENDOR_PASSWORD);
  assert.strictEqual(r.vendors[2].password, 'pw');
});
test('원본 입력 배열은 변경하지 않는다', function () {
  var rows = [{ bizNo: '1111111111', name: 'A', password: '' }];
  Logic.analyzeVendorImport([], rows);
  assert.strictEqual(rows[0].password, '');
});

console.log('\n[11] 숫자 포맷');
test('천 단위 구분 포맷', function () {
  assert.strictEqual(Logic.formatNumber(1234567), '1,234,567');
  assert.strictEqual(Logic.formatNumber(null), '-');
});

console.log('\n총 ' + passed + '개 테스트 통과\n');
