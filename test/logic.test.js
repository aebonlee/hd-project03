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


// ===================================================================
// 2026-08-24 보완 — 마감·지각 / 재고보정 / 총괄표
// ===================================================================

console.log('\n[12] 등록 마감과 지각 판정');
test('마감일이 없으면 지각을 따지지 않는다', function () {
  var r = Logic.computeOverdue(null, '2026-08-24', false);
  assert.strictEqual(r.state, '마감없음');
  assert.strictEqual(r.days, 0);
});
test('마감 전이면 남은 일수를 준다', function () {
  var r = Logic.computeOverdue('2026-08-13', '2026-08-05', false);
  assert.strictEqual(r.state, '여유');
  assert.strictEqual(r.days, 8);
});
test('마감 3일 이내면 임박으로 구분한다', function () {
  assert.strictEqual(Logic.computeOverdue('2026-08-13', '2026-08-11', false).state, '임박');
  assert.strictEqual(Logic.computeOverdue('2026-08-13', '2026-08-13', false).state, '임박');
});
test('마감 당일은 아직 지각이 아니다', function () {
  var r = Logic.computeOverdue('2026-08-13', '2026-08-13', false);
  assert.strictEqual(r.state, '임박');
  assert.strictEqual(r.days, 0);
});
test('마감 다음 날부터 1일 지각', function () {
  var r = Logic.computeOverdue('2026-08-13', '2026-08-14', false);
  assert.strictEqual(r.state, '지각');
  assert.strictEqual(r.days, 1);
});
test('지각일수는 시각이 아니라 날짜 차이로 센다', function () {
  // 같은 날이면 0시 1분이든 23시 59분이든 똑같이 1일 지각이어야 한다
  var early = Logic.computeOverdue('2026-08-13', '2026-08-14T00:01:00', false);
  var late  = Logic.computeOverdue('2026-08-13', '2026-08-14T23:59:00', false);
  assert.strictEqual(early.days, 1);
  assert.strictEqual(late.days, 1);
});
test('11일 지각도 정확히 센다', function () {
  assert.strictEqual(Logic.computeOverdue('2026-08-13', '2026-08-24', false).days, 11);
});
test('기한 내 제출은 지각이 아니다', function () {
  var r = Logic.computeOverdue('2026-08-13', '2026-08-24', true, '2026-08-12T10:24:00');
  assert.strictEqual(r.state, '기한내제출');
  assert.strictEqual(r.days, 0);
});
test('마감 뒤 제출은 지각 제출로 남는다', function () {
  // 이미 냈어도 며칠 늦었는지는 기록으로 남아야 한다
  var r = Logic.computeOverdue('2026-08-13', '2026-08-24', true, '2026-08-14T16:41:00');
  assert.strictEqual(r.state, '지각제출');
  assert.strictEqual(r.days, 1);
});
test('제출 시각이 없는 옛 데이터를 지각으로 몰지 않는다', function () {
  var r = Logic.computeOverdue('2026-08-13', '2026-08-24', true, null);
  assert.strictEqual(r.state, '기한내제출');
});
test('잘못된 마감일은 마감없음으로 처리한다', function () {
  assert.strictEqual(Logic.computeOverdue('없음', '2026-08-24', false).state, '마감없음');
});

console.log('\n[13] 전원 등록 완료 판정');
var vAll = [{ bizNo: '1111111111', name: 'A' }, { bizNo: '2222222222', name: 'B' }];
test('한 곳이라도 미제출이면 완료가 아니다', function () {
  var audits = [{ id: 'X1', bizNo: '1111111111', round: 'R', status: '제출' }];
  assert.strictEqual(Logic.allSubmitted(vAll, audits, [], 'R'), false);
});
test('전 업체가 제출하면 완료다', function () {
  var audits = [
    { id: 'X1', bizNo: '1111111111', round: 'R', status: '제출' },
    { id: 'X2', bizNo: '2222222222', round: 'R', status: '승인' }
  ];
  assert.strictEqual(Logic.allSubmitted(vAll, audits, [], 'R'), true);
});
test('작성중은 제출로 치지 않는다', function () {
  var audits = [
    { id: 'X1', bizNo: '1111111111', round: 'R', status: '제출' },
    { id: 'X2', bizNo: '2222222222', round: 'R', status: '작성중' }
  ];
  assert.strictEqual(Logic.allSubmitted(vAll, audits, [], 'R'), false);
});
test('다른 회차의 제출은 이번 회차 완료로 치지 않는다', function () {
  var audits = [
    { id: 'X1', bizNo: '1111111111', round: 'R', status: '제출' },
    { id: 'X2', bizNo: '2222222222', round: '이전회차', status: '제출' }
  ];
  assert.strictEqual(Logic.allSubmitted(vAll, audits, [], 'R'), false);
});
test('업체가 하나도 없으면 완료가 아니다', function () {
  assert.strictEqual(Logic.allSubmitted([], [], [], 'R'), false);
});

console.log('\n[14] 재고보정 판정');
test('차이가 있으면 보정 대상 후보다', function () {
  assert.strictEqual(Logic.isCorrectionCandidate({ diff: -1, unitPrice: 100 }), true);
  assert.strictEqual(Logic.isCorrectionCandidate({ diff: 3, unitPrice: 100 }), true);
});
test('차이가 0이면 보정 대상이 아니다', function () {
  assert.strictEqual(Logic.isCorrectionCandidate({ diff: 0, unitPrice: 100 }), false);
});
test('실사 미입력 라인은 보정 대상이 아니다', function () {
  assert.strictEqual(Logic.isCorrectionCandidate({ diff: null, unitPrice: 100 }), false);
});
test('삭제(대여 종료) 요청은 보정이 아니라 별도 승인 흐름이다', function () {
  assert.strictEqual(Logic.isCorrectionCandidate({ diff: -5, unitPrice: 100, deleteRequested: true }), false);
});
test('보정금액 = 차이 x 단가, 부족이면 음수', function () {
  assert.strictEqual(Logic.correctionAmount({ diff: -1, unitPrice: 69966 }), -69966);
  assert.strictEqual(Logic.correctionAmount({ diff: 2, unitPrice: 4500 }), 9000);
  assert.strictEqual(Logic.correctionAmount({ diff: 0, unitPrice: 4500 }), 0);
});

console.log('\n[15] 보정요청 리스트 (총괄표 하단)');
var corrVendors = [
  { bizNo: '1111111111', name: '한양정밀' },
  { bizNo: '2222222222', name: '선진정공' }
];
var corrLines = [
  { bizNo: '1111111111', partNo: '410102-00052E', itemName: 'VALVE,BRAKE SUPPLY',
    diff: -1, unitPrice: 69966, correction: 'O', fault: 'HCE', action: 'Z05', reason: '자가불량 (나사선 마모)' },
  { bizNo: '2222222222', partNo: '421-00021A', itemName: 'VALVE,HYDRAULIC',
    diff: -1, unitPrice: 10918, correction: 'O', fault: '협력업체', action: 'Z05', reason: '자가불량 (파손)' },
  // 보정 O가 아닌 것은 리스트에 들어가면 안 된다
  { bizNo: '1111111111', partNo: '999-00001A', itemName: '판단대기품목',
    diff: -3, unitPrice: 1000, correction: '', reason: '검토중' },
  { bizNo: '1111111111', partNo: '999-00002A', itemName: '보정불필요품목',
    diff: -2, unitPrice: 1000, correction: 'X', reason: '현장 재확인 결과 일치' }
];
test('보정 O 표시가 있는 건만 별도로 취합된다', function () {
  var r = Logic.buildCorrectionList(corrVendors, corrLines);
  assert.strictEqual(r.rows.length, 2);
  assert.deepStrictEqual(r.rows.map(function (x) { return x.partNo; }),
    ['410102-00052E', '421-00021A']);
});
test('보정 판단이 안 됐거나 X인 건은 빠진다', function () {
  var r = Logic.buildCorrectionList(corrVendors, corrLines);
  var names = r.rows.map(function (x) { return x.itemName; });
  assert.ok(names.indexOf('판단대기품목') < 0);
  assert.ok(names.indexOf('보정불필요품목') < 0);
});
test('실제 총괄표의 보정금액과 일치한다', function () {
  var r = Logic.buildCorrectionList(corrVendors, corrLines);
  assert.strictEqual(r.rows[0].correctionAmount, -69966);
  assert.strictEqual(r.rows[1].correctionAmount, -10918);
  assert.strictEqual(r.totalAmount, -80884);
  assert.strictEqual(r.totalQty, -2);
});
test('업체별 소계가 붙는다', function () {
  var r = Logic.buildCorrectionList(corrVendors, corrLines);
  assert.strictEqual(r.subtotals.length, 2);
  assert.strictEqual(r.subtotals[0].vendorName, '한양정밀 소계');
  assert.strictEqual(r.subtotals[0].correctionAmount, -69966);
});
test('귀책과 조치사항이 그대로 실린다', function () {
  var r = Logic.buildCorrectionList(corrVendors, corrLines);
  assert.strictEqual(r.rows[0].fault, 'HCE');
  assert.strictEqual(r.rows[1].fault, '협력업체');
  assert.strictEqual(r.rows[0].action, 'Z05');
});
test('보정 건이 없으면 빈 리스트다', function () {
  var r = Logic.buildCorrectionList(corrVendors, []);
  assert.strictEqual(r.rows.length, 0);
  assert.strictEqual(r.totalAmount, 0);
});

console.log('\n[16] 총괄표 상단 집계');
var sumLines = [
  { bookQty: 10, actualQty: 10, diff: 0, unitPrice: 1000 },
  { bookQty: 5,  actualQty: 5,  diff: 0, unitPrice: 2000 },
  { bookQty: 8,  actualQty: 6,  diff: -2, unitPrice: 500 },   // 부족 2
  { bookQty: 4,  actualQty: 7,  diff: 3,  unitPrice: 100 }    // 과잉 3
];
test('실사대상 수량은 실물재고 합이다', function () {
  var s = Logic.buildSummaryRow(sumLines);
  assert.strictEqual(s.actualQty, 10 + 5 + 6 + 7);
  assert.strictEqual(s.actualAmount, 10 * 1000 + 5 * 2000 + 6 * 500 + 7 * 100);
});
test('전월 마감 재고는 라인 수와 장부금액이다', function () {
  var s = Logic.buildSummaryRow(sumLines);
  assert.strictEqual(s.bookLines, 4);
  assert.strictEqual(s.bookAmount, 10 * 1000 + 5 * 2000 + 8 * 500 + 4 * 100);
});
test('과잉과 부족을 나눠 센다', function () {
  var s = Logic.buildSummaryRow(sumLines);
  assert.strictEqual(s.overQty, 3);
  assert.strictEqual(s.shortQty, 2);
  assert.strictEqual(s.matchQty, 15);
});
test('금액 NET = 과잉금액 - 부족금액', function () {
  var s = Logic.buildSummaryRow(sumLines);
  assert.strictEqual(s.overAmount, 300);
  assert.strictEqual(s.shortAmount, 1000);
  assert.strictEqual(s.netAmount, -700);
});
test('전량 일치면 일치율 100%', function () {
  var s = Logic.buildSummaryRow([{ bookQty: 5, actualQty: 5, diff: 0, unitPrice: 100 }]);
  assert.strictEqual(s.qtyMatchRate, 100);
  assert.strictEqual(s.amountMatchRate, 100);
});
test('보정 확정 라인은 상단 일치도에서 빠진다', function () {
  // 원본 총괄표에서 보정 2건이 있는데도 상단 일치율이 100%였던 구조
  var lines = [
    { bookQty: 25, actualQty: 24, diff: -1, unitPrice: 69966, correction: 'O' }
  ];
  var withOpt = Logic.buildSummaryRow(lines, { excludeCorrected: true });
  assert.strictEqual(withOpt.qtyMatchRate, 100);
  assert.strictEqual(withOpt.shortQty, 0);

  var without = Logic.buildSummaryRow(lines);
  assert.strictEqual(without.shortQty, 1);
  assert.ok(without.qtyMatchRate < 100);
});
test('실사 미입력 라인은 실사율에 반영된다', function () {
  var s = Logic.buildSummaryRow([
    { bookQty: 5, actualQty: 5, diff: 0, unitPrice: 100 },
    { bookQty: 5, actualQty: null, diff: null, unitPrice: 100 }
  ]);
  assert.strictEqual(s.auditRate, 50);
});
test('라인이 없으면 비율은 null이다', function () {
  var s = Logic.buildSummaryRow([]);
  assert.strictEqual(s.qtyMatchRate, null);
  assert.strictEqual(s.auditRate, null);
});

console.log('\n[17] 결과 추출 전 점검');
var pfVendors = [
  { bizNo: '1111111111', name: '제출완료업체' },
  { bizNo: '2222222222', name: '확인서누락업체' },
  { bizNo: '3333333333', name: '미제출업체' }
];
var pfAudits = [
  { id: 'P1', bizNo: '1111111111', round: 'R', status: '제출' },
  { id: 'P2', bizNo: '2222222222', round: 'R', status: '제출' }
];
var pfLines = [
  { auditId: 'P1', bizNo: '1111111111', itemName: '정상품', diff: 0, unitPrice: 100 },
  { auditId: 'P2', bizNo: '2222222222', itemName: '판단대기품', diff: -1, unitPrice: 100, correction: '' }
];
var pfAtt = [{ auditId: 'P1', fileName: 'a.pdf' }];
test('미제출 업체를 짚어 준다', function () {
  var r = Logic.buildPreflight(pfVendors, pfAudits, pfLines, pfAtt, 'R');
  assert.deepStrictEqual(r.notSubmitted, ['미제출업체']);
});
test('결과확인서가 없는 업체를 짚어 준다', function () {
  var r = Logic.buildPreflight(pfVendors, pfAudits, pfLines, pfAtt, 'R');
  assert.deepStrictEqual(r.missingCert, ['확인서누락업체']);
});
test('보정 판단이 남은 불일치를 짚어 준다', function () {
  var r = Logic.buildPreflight(pfVendors, pfAudits, pfLines, pfAtt, 'R');
  assert.strictEqual(r.pendingCorrection.length, 1);
  assert.strictEqual(r.pendingCorrection[0].itemName, '판단대기품');
});
test('셋 다 없어야 결과 추출 준비 완료다', function () {
  var r = Logic.buildPreflight(pfVendors, pfAudits, pfLines, pfAtt, 'R');
  assert.strictEqual(r.ready, false);

  var clean = Logic.buildPreflight(
    [{ bizNo: '1111111111', name: '제출완료업체' }],
    [{ id: 'P1', bizNo: '1111111111', round: 'R', status: '제출' }],
    [{ auditId: 'P1', bizNo: '1111111111', itemName: '정상품', diff: 0, unitPrice: 100 }],
    [{ auditId: 'P1', fileName: 'a.pdf' }], 'R');
  assert.strictEqual(clean.ready, true);
});
test('보정 판단이 끝난 불일치는 준비 완료를 막지 않는다', function () {
  var r = Logic.buildPreflight(
    [{ bizNo: '1111111111', name: 'A' }],
    [{ id: 'P1', bizNo: '1111111111', round: 'R', status: '제출' }],
    [{ auditId: 'P1', bizNo: '1111111111', itemName: '보정확정품', diff: -1, unitPrice: 100, correction: 'O' }],
    [{ auditId: 'P1', fileName: 'a.pdf' }], 'R');
  assert.strictEqual(r.pendingCorrection.length, 0);
  assert.strictEqual(r.mismatch.length, 1);   // 불일치 자체는 보고된다
  assert.strictEqual(r.ready, true);
});

console.log('\n총 ' + passed + '개 테스트 통과\n');
