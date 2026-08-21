/**
 * logic.js — 순수 비즈니스 로직 모듈
 *
 * 업체 대여 아이템 재고관리 보고서 자동화
 * - 일치도 계산(수량/금액), 제출 검증, 권한 필터, 인증, 파일 검증 등
 * - DOM/localStorage 의존성이 없는 순수 함수만 포함 (Node 테스트 가능)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(); // Node (테스트)
  } else {
    root.Logic = factory(); // 브라우저
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 허용 첨부 확장자 */
  var ALLOWED_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png'];
  /** 첨부 최대 크기 (10MB) */
  var MAX_FILE_SIZE = 10 * 1024 * 1024;

  /** 실사 제출 상태 상수 */
  var AUDIT_STATUS = {
    DRAFT: '작성중',
    SUBMITTED: '제출',
    REVIEWING: '검토중',
    APPROVED: '승인'
  };

  /** 아이템 상태 상수 */
  var ITEM_STATUS = {
    RENTED: '대여중',
    END_REQUESTED: '종료요청',
    ENDED: '종료'
  };

  // ---------------------------------------------------------------
  // 인증 / 권한
  // ---------------------------------------------------------------

  /**
   * 사업자번호 형식 정규화 (숫자만 남김)
   * 예: "123-45-67890" -> "1234567890"
   */
  function normalizeBizNo(bizNo) {
    return String(bizNo == null ? '' : bizNo).replace(/[^0-9]/g, '');
  }

  /**
   * 업체 로그인 인증.
   * @returns {object|null} 일치하는 업체 객체 또는 null
   */
  function authenticateVendor(vendors, bizNo, password) {
    if (!Array.isArray(vendors)) return null;
    var target = normalizeBizNo(bizNo);
    if (!target) return null;
    for (var i = 0; i < vendors.length; i++) {
      var v = vendors[i];
      if (normalizeBizNo(v.bizNo) === target && String(v.password) === String(password)) {
        return v;
      }
    }
    return null;
  }

  /**
   * 권한 필터: 해당 업체의 데이터만 반환한다.
   * 업체 간 데이터 교차 노출을 막는 핵심 함수 — 업체 화면의 모든 목록은
   * 반드시 이 함수를 거쳐야 한다.
   */
  function filterByVendor(records, bizNo) {
    if (!Array.isArray(records)) return [];
    var target = normalizeBizNo(bizNo);
    return records.filter(function (r) {
      return normalizeBizNo(r.bizNo) === target;
    });
  }

  // ---------------------------------------------------------------
  // 실사 라인 계산
  // ---------------------------------------------------------------

  /**
   * 실사 라인 1건 계산.
   * @param {object} item  대여 아이템 (qty: 장부수량, unitPrice: 단가)
   * @param {number|string|null} actualQty  실사 수량 (미입력 시 null)
   * @param {boolean} [deleteRequested]  삭제(대여 종료) 요청 여부
   * @returns {{itemId, bookQty, actualQty, diff, amountDiff, match, deleteRequested}}
   */
  function computeLine(item, actualQty, deleteRequested) {
    var bookQty = Number(item.qty) || 0;
    var unitPrice = Number(item.unitPrice) || 0;
    var isDelete = !!deleteRequested;
    var actual = null;

    if (isDelete) {
      // 삭제 요청 라인은 실사 수량 0으로 간주
      actual = 0;
    } else if (actualQty !== null && actualQty !== undefined && actualQty !== '') {
      actual = Number(actualQty);
      if (isNaN(actual) || actual < 0) actual = null;
    }

    var diff = actual === null ? null : actual - bookQty;
    return {
      itemId: item.id,
      bookQty: bookQty,
      unitPrice: unitPrice,
      bookAmount: bookQty * unitPrice,
      actualQty: actual,
      diff: diff,
      amountDiff: diff === null ? null : diff * unitPrice,
      match: diff === null ? null : diff === 0,
      deleteRequested: isDelete
    };
  }

  // ---------------------------------------------------------------
  // 제출 검증
  // ---------------------------------------------------------------

  /**
   * 실사 제출 검증.
   * 규칙:
   *  1) 모든 라인에 실사 수량 입력(또는 삭제 요청) 필수
   *  2) 불일치(diff != 0) 라인은 소명 사유 필수 — 없으면 제출 차단
   *  3) 삭제 요청 라인도 사유 필수
   *  4) 실사결과 확인서 첨부 필수
   * @param {Array} lines  computeLine 결과 + reason 필드
   * @param {object|null} attachment  {fileName, size} 또는 null
   * @returns {{ok: boolean, errors: string[]}}
   */
  function validateSubmission(lines, attachment) {
    var errors = [];
    if (!Array.isArray(lines) || lines.length === 0) {
      errors.push('실사 대상 아이템이 없습니다.');
      return { ok: false, errors: errors };
    }
    lines.forEach(function (line, idx) {
      var label = line.itemName ? '[' + line.itemName + ']' : '(' + (idx + 1) + '번 아이템)';
      if (!line.deleteRequested && (line.actualQty === null || line.actualQty === undefined)) {
        errors.push(label + ' 실사 수량이 입력되지 않았습니다.');
        return;
      }
      var reason = String(line.reason == null ? '' : line.reason).trim();
      if (line.deleteRequested && !reason) {
        errors.push(label + ' 삭제(대여 종료) 요청 사유를 입력해 주세요.');
      } else if (!line.deleteRequested && line.diff !== 0 && !reason) {
        errors.push(label + ' 수량 불일치 — 소명 사유 입력이 필요합니다.');
      }
    });
    if (!attachment || !attachment.fileName) {
      errors.push('실사결과 확인서 파일을 첨부해 주세요.');
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /**
   * 첨부 파일 검증 (10MB 제한, PDF/JPG/PNG).
   * @returns {{ok: boolean, error: string|null}}
   */
  function validateFile(fileName, size) {
    var name = String(fileName == null ? '' : fileName);
    var dot = name.lastIndexOf('.');
    var ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
    if (ALLOWED_EXTENSIONS.indexOf(ext) === -1) {
      return { ok: false, error: 'PDF, JPG, PNG 파일만 업로드할 수 있습니다.' };
    }
    if (Number(size) > MAX_FILE_SIZE) {
      return { ok: false, error: '파일 크기는 10MB를 초과할 수 없습니다.' };
    }
    return { ok: true, error: null };
  }

  // ---------------------------------------------------------------
  // 일치도 지표
  // ---------------------------------------------------------------

  /**
   * 일치도 지표 계산.
   *
   * 정의(README 참조):
   *  - 수량 일치도(%) = (1 - Σ|실사-장부| / Σ장부수량) × 100
   *  - 금액 일치도(%) = (1 - Σ|금액차이| / Σ장부금액) × 100
   *  - 라인 일치율(%) = 일치 라인 수 / 실사 라인 수 × 100
   *  - 삭제 요청 라인은 실사수량 0으로 차이에 포함
   *  - 미입력(actualQty null) 라인은 지표에서 제외
   *
   * @param {Array} lines  computeLine 결과 배열 (unitPrice 포함 필요 없음 — amountDiff 사용)
   * @returns {{qtyRate, amountRate, lineRate, mismatchCount, deleteCount, totalLines, countedLines,
   *            totalBookQty, totalActualQty, totalBookAmount, totalDiffQty, totalDiffAmount}}
   */
  function computeMatchRates(lines) {
    var totalBookQty = 0;
    var totalActualQty = 0;
    var totalAbsDiffQty = 0;
    var totalBookAmount = 0;
    var totalAbsDiffAmount = 0;
    var matched = 0;
    var counted = 0;
    var mismatchCount = 0;
    var deleteCount = 0;

    (lines || []).forEach(function (line) {
      if (line.deleteRequested) deleteCount++;
      if (line.actualQty === null || line.actualQty === undefined) return;
      counted++;
      var bookQty = Number(line.bookQty) || 0;
      var bookAmount = line.bookAmount !== undefined
        ? Number(line.bookAmount) || 0
        : bookQty * (Number(line.unitPrice) || 0);
      totalBookQty += bookQty;
      totalActualQty += Number(line.actualQty) || 0;
      totalBookAmount += bookAmount;
      totalAbsDiffQty += Math.abs(Number(line.diff) || 0);
      totalAbsDiffAmount += Math.abs(Number(line.amountDiff) || 0);
      if ((Number(line.diff) || 0) === 0) matched++;
      else mismatchCount++;
    });

    function rate(absDiff, base) {
      if (base <= 0) return 100;
      var r = (1 - absDiff / base) * 100;
      return Math.max(0, Math.round(r * 10) / 10);
    }

    return {
      qtyRate: rate(totalAbsDiffQty, totalBookQty),
      amountRate: rate(totalAbsDiffAmount, totalBookAmount),
      lineRate: counted === 0 ? 100 : Math.round((matched / counted) * 1000) / 10,
      mismatchCount: mismatchCount,
      deleteCount: deleteCount,
      totalLines: (lines || []).length,
      countedLines: counted,
      totalBookQty: totalBookQty,
      totalActualQty: totalActualQty,
      totalBookAmount: totalBookAmount,
      totalDiffQty: totalAbsDiffQty,
      totalDiffAmount: totalAbsDiffAmount
    };
  }

  // ---------------------------------------------------------------
  // 제출 현황 (담당자 대시보드)
  // ---------------------------------------------------------------

  /**
   * 특정 회차의 업체 제출 현황 분류.
   * @returns {'미제출'|'제출'|'불일치 있음'|'승인 완료'}
   */
  function vendorSubmissionStatus(audits, auditLines, bizNo, round) {
    var target = normalizeBizNo(bizNo);
    var audit = (audits || []).find(function (a) {
      return normalizeBizNo(a.bizNo) === target && a.round === round &&
        a.status !== AUDIT_STATUS.DRAFT;
    });
    if (!audit) return '미제출';
    if (audit.status === AUDIT_STATUS.APPROVED) return '승인 완료';
    var lines = (auditLines || []).filter(function (l) { return l.auditId === audit.id; });
    var hasMismatch = lines.some(function (l) {
      return l.deleteRequested || (l.diff !== null && l.diff !== 0);
    });
    return hasMismatch ? '불일치 있음' : '제출';
  }

  /**
   * 담당자 대시보드용 업체별 현황 요약.
   */
  function buildDashboard(vendors, audits, auditLines, round) {
    var rows = (vendors || []).map(function (v) {
      var status = vendorSubmissionStatus(audits, auditLines, v.bizNo, round);
      var audit = (audits || []).find(function (a) {
        return normalizeBizNo(a.bizNo) === normalizeBizNo(v.bizNo) &&
          a.round === round && a.status !== AUDIT_STATUS.DRAFT;
      });
      var lines = audit
        ? (auditLines || []).filter(function (l) { return l.auditId === audit.id; })
        : [];
      var rates = computeMatchRates(lines);
      return {
        bizNo: v.bizNo,
        vendorName: v.name,
        status: status,
        auditId: audit ? audit.id : null,
        submittedAt: audit ? audit.submittedAt : null,
        mismatchCount: audit ? rates.mismatchCount : null,
        deleteCount: audit ? rates.deleteCount : null,
        qtyRate: audit ? rates.qtyRate : null,
        amountRate: audit ? rates.amountRate : null
      };
    });
    var summary = { total: rows.length, notSubmitted: 0, submitted: 0, mismatch: 0, approved: 0 };
    rows.forEach(function (r) {
      if (r.status === '미제출') summary.notSubmitted++;
      else if (r.status === '제출') summary.submitted++;
      else if (r.status === '불일치 있음') summary.mismatch++;
      else if (r.status === '승인 완료') summary.approved++;
    });
    return { rows: rows, summary: summary };
  }

  // ---------------------------------------------------------------
  // 포맷 유틸
  // ---------------------------------------------------------------

  /** 숫자 → "1,234,567" */
  function formatNumber(n) {
    if (n === null || n === undefined || isNaN(Number(n))) return '-';
    return Number(n).toLocaleString('ko-KR');
  }

  /** "1234567890" → "123-45-67890" */
  function formatBizNo(bizNo) {
    var d = normalizeBizNo(bizNo);
    if (d.length !== 10) return String(bizNo == null ? '' : bizNo);
    return d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5);
  }

  return {
    ALLOWED_EXTENSIONS: ALLOWED_EXTENSIONS,
    MAX_FILE_SIZE: MAX_FILE_SIZE,
    AUDIT_STATUS: AUDIT_STATUS,
    ITEM_STATUS: ITEM_STATUS,
    normalizeBizNo: normalizeBizNo,
    authenticateVendor: authenticateVendor,
    filterByVendor: filterByVendor,
    computeLine: computeLine,
    validateSubmission: validateSubmission,
    validateFile: validateFile,
    computeMatchRates: computeMatchRates,
    vendorSubmissionStatus: vendorSubmissionStatus,
    buildDashboard: buildDashboard,
    formatNumber: formatNumber,
    formatBizNo: formatBizNo
  };
});
