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
  // 기준 데이터 임포트 분석
  // ---------------------------------------------------------------

  /** 업체 임포트 시 비밀번호 미입력 행에 적용되는 기본값 */
  var DEFAULT_VENDOR_PASSWORD = '1234';

  /**
   * 업체 임포트 사전 분석.
   * 규칙:
   *  1) 파일 내 동일 사업자번호 중복 → 마지막 행이 우선, 중복 건수 집계
   *  2) 기존 데이터와 사업자번호가 겹치면 "덮어씀", 아니면 "신규"로 분류
   *  3) 비밀번호 미입력 행은 기본값('1234')을 적용하되 건수를 집계해 보고
   * @param {Array} existingVendors  현재 저장된 업체 목록
   * @param {Array} importedRows  파일에서 파싱한 업체 목록 (password는 빈 문자열 가능)
   * @returns {{vendors: Array, newCount: number, overwriteCount: number,
   *            duplicateInFileCount: number, defaultPasswordCount: number}}
   */
  function analyzeVendorImport(existingVendors, importedRows) {
    var seen = {};
    var deduped = [];
    var duplicateInFileCount = 0;
    (importedRows || []).forEach(function (row) {
      var v = Object.assign({}, row);
      var key = normalizeBizNo(v.bizNo);
      if (seen[key] !== undefined) {
        duplicateInFileCount++;
        deduped[seen[key]] = v; // 파일 내 중복 시 마지막 행 우선
      } else {
        seen[key] = deduped.length;
        deduped.push(v);
      }
    });

    var defaultPasswordCount = 0;
    deduped.forEach(function (v) {
      if (!String(v.password == null ? '' : v.password).trim()) {
        v.password = DEFAULT_VENDOR_PASSWORD;
        defaultPasswordCount++;
      }
    });

    var existingKeys = {};
    (existingVendors || []).forEach(function (v) {
      existingKeys[normalizeBizNo(v.bizNo)] = true;
    });
    var newCount = 0;
    var overwriteCount = 0;
    deduped.forEach(function (v) {
      if (existingKeys[normalizeBizNo(v.bizNo)]) overwriteCount++;
      else newCount++;
    });

    return {
      vendors: deduped,
      newCount: newCount,
      overwriteCount: overwriteCount,
      duplicateInFileCount: duplicateInFileCount,
      defaultPasswordCount: defaultPasswordCount
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
  // 회차 마감·지각 (2026-08-24 보완)
  // ---------------------------------------------------------------

  /** 'YYYY-MM-DD' 또는 Date → 그 날 23:59:59 의 타임스탬프. 마감일은 그날까지를 뜻한다. */
  function endOfDay(dateLike) {
    if (!dateLike) return null;
    var d = dateLike instanceof Date ? new Date(dateLike.getTime()) : new Date(String(dateLike) + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  /** 날짜만 남긴 자정 타임스탬프 — 지각 "일수"는 시각이 아니라 날짜 차이로 센다. */
  function startOfDay(dateLike) {
    var d = dateLike instanceof Date ? new Date(dateLike.getTime()) : new Date(dateLike);
    if (isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  var DAY_MS = 24 * 60 * 60 * 1000;

  /**
   * 업체의 등록 지각 여부를 판정한다.
   *
   * 지각일수는 시각 차이가 아니라 **날짜 차이**로 센다. 마감 다음 날 0시 1분이든
   * 23시 59분이든 똑같이 "1일 지각"이어야 화면 문구가 상식과 맞는다.
   *
   * @param {string|Date|null} dueDate  마감일 (없으면 마감 미설정)
   * @param {string|Date} now  기준 시각
   * @param {boolean} submitted  이미 제출했는지
   * @param {string|Date|null} [submittedAt]  제출 시각 — 제출했다면 이 시점으로 지각을 판정한다
   * @returns {{state:'마감없음'|'여유'|'임박'|'지각'|'지각제출'|'기한내제출', days:number, dueDate:string|null}}
   */
  function computeOverdue(dueDate, now, submitted, submittedAt) {
    var due = endOfDay(dueDate);
    if (due === null) return { state: '마감없음', days: 0, dueDate: null };

    var dueDay = startOfDay(new Date(due));
    var iso = new Date(due);
    var dueStr = iso.getFullYear() + '-'
      + String(iso.getMonth() + 1).padStart(2, '0') + '-'
      + String(iso.getDate()).padStart(2, '0');

    if (submitted) {
      // 제출 시각이 없으면 지각으로 몰지 않는다 — 옛 데이터에는 시각이 없을 수 있다.
      var at = submittedAt ? startOfDay(submittedAt) : null;
      if (at === null || at <= dueDay) return { state: '기한내제출', days: 0, dueDate: dueStr };
      return { state: '지각제출', days: Math.round((at - dueDay) / DAY_MS), dueDate: dueStr };
    }

    var today = startOfDay(now);
    if (today === null) return { state: '마감없음', days: 0, dueDate: dueStr };

    if (today > dueDay) {
      return { state: '지각', days: Math.round((today - dueDay) / DAY_MS), dueDate: dueStr };
    }
    var left = Math.round((dueDay - today) / DAY_MS);
    return { state: left <= 3 ? '임박' : '여유', days: left, dueDate: dueStr };
  }

  /** 회차의 모든 업체가 제출(또는 승인)을 마쳤는가. */
  function allSubmitted(vendors, audits, auditLines, round) {
    var list = vendors || [];
    if (list.length === 0) return false;
    return list.every(function (v) {
      return vendorSubmissionStatus(audits, auditLines, v.bizNo, round) !== '미제출';
    });
  }

  // ---------------------------------------------------------------
  // 재고보정 (2026-08-24 보완 — 총괄표 하단 "보정요청 리스트")
  // ---------------------------------------------------------------

  /** 귀책 구분 — 총괄표 K열 */
  var FAULT = { HCE: 'HCE', VENDOR: '협력업체' };
  /** 조치사항 코드 — 총괄표 L열. 실제 양식에 쓰인 값 */
  var ACTION_CORRECTION = 'Z05';

  /**
   * 이 라인이 재고보정 대상인가.
   *
   * 총괄표에서 재고보정 O가 붙은 두 건은 모두 "전산재고 ≠ 실물재고"이면서
   * 대여 종료(삭제) 요청이 아닌 건이었다. 삭제 요청은 별도 승인 흐름을 타므로
   * 보정요청 리스트에 넣지 않는다.
   */
  function isCorrectionCandidate(line) {
    if (!line || line.deleteRequested) return false;
    var diff = Number(line.diff);
    return line.diff !== null && line.diff !== undefined && !isNaN(diff) && diff !== 0;
  }

  /** 보정금액 = 차이 × 단가. 부족이면 음수가 된다(총괄표와 같은 부호). */
  function correctionAmount(line) {
    if (!isCorrectionCandidate(line)) return 0;
    return (Number(line.diff) || 0) * (Number(line.unitPrice) || 0);
  }

  /**
   * 총괄표 하단 "보정요청 리스트"를 만든다.
   * 업체별로 묶고 소계를 붙인다 — 실제 양식이 그렇게 되어 있다.
   *
   * @param {Array} vendors
   * @param {Array} lines  재고보정이 확정된(correction === 'O') 라인만 들어온다
   * @returns {{rows: Array, subtotals: Array, totalQty: number, totalAmount: number}}
   */
  function buildCorrectionList(vendors, lines) {
    var nameOf = {};
    (vendors || []).forEach(function (v) { nameOf[normalizeBizNo(v.bizNo)] = v.name; });

    var picked = (lines || []).filter(function (l) {
      return String(l.correction || '').trim().toUpperCase() === 'O';
    });

    var byVendor = {};
    picked.forEach(function (l) {
      var key = normalizeBizNo(l.bizNo);
      if (!byVendor[key]) byVendor[key] = [];
      byVendor[key].push(l);
    });

    var rows = [];
    var subtotals = [];
    var totalQty = 0;
    var totalAmount = 0;

    Object.keys(byVendor).sort().forEach(function (key) {
      var vname = nameOf[key] || key;
      var sumQty = 0;
      var sumAmt = 0;
      byVendor[key].forEach(function (l) {
        var qty = Number(l.diff) || 0;
        var amt = correctionAmount(l);
        sumQty += qty;
        sumAmt += amt;
        rows.push({
          bizNo: l.bizNo,
          vendorName: vname,
          partNo: l.partNo || '',
          itemName: l.itemName || '',
          correctionQty: qty,
          correctionAmount: amt,
          fault: l.fault || '',
          action: l.action || ACTION_CORRECTION,
          reason: l.reason || ''
        });
      });
      subtotals.push({ vendorName: vname + ' 소계', correctionQty: sumQty, correctionAmount: sumAmt });
      totalQty += sumQty;
      totalAmount += sumAmt;
    });

    return { rows: rows, subtotals: subtotals, totalQty: totalQty, totalAmount: totalAmount };
  }

  // ---------------------------------------------------------------
  // 총괄표 상단 집계 (2026-08-24 보완)
  // ---------------------------------------------------------------

  /**
   * 총괄표 상단 한 행을 만든다.
   *
   * 실제 양식의 열 의미를 원본 파일로 실측해 맞췄다.
   *  - C·D(전월 마감 재고): 품목수 = 라인 수, 금액 = 전산재고 기준 금액
   *  - E·F(실사 대상):     품목수 = **실물재고 수량 합**, 금액 = 실물재고 기준 금액
   *    (E열 머리글이 "품목수"지만 라인 수가 아니라 수량 합이다. 원본 10개 업체 전부에서 일치했다)
   *  - H~K(품목기준): 일치 = 차이 0인 라인의 실물 수량 합, 과잉 = +차이 합, 부족 = -차이 합
   *  - L~P(금액기준): 같은 방식의 금액판. NET = 과잉 − 부족
   *
   * @param {Array} lines  이 업체의 실사 라인
   * @param {object} [opts] { excludeCorrected: true } 보정 확정 라인을 일치도에서 뺄지
   */
  function buildSummaryRow(lines, opts) {
    var excludeCorrected = !!(opts && opts.excludeCorrected);
    var bookLines = 0, bookAmount = 0;
    var actualQty = 0, actualAmount = 0;
    var matchQty = 0, overQty = 0, shortQty = 0;
    var matchAmt = 0, overAmt = 0, shortAmt = 0;

    (lines || []).forEach(function (l) {
      var price = Number(l.unitPrice) || 0;
      var book = Number(l.bookQty) || 0;
      bookLines += 1;
      bookAmount += book * price;

      if (l.actualQty === null || l.actualQty === undefined) return;
      var act = Number(l.actualQty) || 0;
      actualQty += act;
      actualAmount += act * price;

      // 보정이 확정된 라인은 총괄표 상단에서 빠지고 하단 보정요청 리스트로 간다.
      // 원본 파일에서 보정 2건이 있는데도 상단 일치율이 100%였던 이유가 이것이다.
      var corrected = String(l.correction || '').trim().toUpperCase() === 'O';
      if (excludeCorrected && corrected) {
        matchQty += act;
        matchAmt += act * price;
        return;
      }

      var diff = Number(l.diff) || 0;
      if (diff === 0) { matchQty += act; matchAmt += act * price; }
      else if (diff > 0) { overQty += diff; overAmt += diff * price; }
      else { shortQty += -diff; shortAmt += -diff * price; }
    });

    function pct(part, whole) {
      if (whole <= 0) return null;
      return Math.round((part / whole) * 1000) / 10;
    }

    return {
      bookLines: bookLines,
      bookAmount: bookAmount,
      actualQty: actualQty,
      actualAmount: actualAmount,
      // 실사율 = 실사한 라인 ÷ 전체 라인
      auditRate: pct((lines || []).filter(function (l) {
        return l.actualQty !== null && l.actualQty !== undefined;
      }).length, bookLines),
      matchQty: matchQty, overQty: overQty, shortQty: shortQty,
      qtyMatchRate: pct(matchQty, actualQty),
      matchAmount: matchAmt, overAmount: overAmt, shortAmount: shortAmt,
      netAmount: overAmt - shortAmt,
      amountMatchRate: pct(matchAmt, actualAmount)
    };
  }

  /** 총괄표 상단 전체 — 업체별 행 + 합계 행. */
  function buildSummaryTable(vendors, audits, auditLines, round, opts) {
    var rows = (vendors || []).map(function (v) {
      var audit = (audits || []).find(function (a) {
        return normalizeBizNo(a.bizNo) === normalizeBizNo(v.bizNo) &&
          a.round === round && a.status !== AUDIT_STATUS.DRAFT;
      });
      var lines = audit
        ? (auditLines || []).filter(function (l) { return l.auditId === audit.id; })
        : [];
      var s = buildSummaryRow(lines, opts);
      s.bizNo = v.bizNo;
      s.vendorCode = v.vendorCode || '';
      s.vendorName = v.name;
      s.submitted = !!audit;
      s.status = vendorSubmissionStatus(audits, auditLines, v.bizNo, round);
      return s;
    });

    var all = [];
    rows.forEach(function (r) { all.push(r); });
    var totalLines = [];
    (vendors || []).forEach(function (v) {
      var audit = (audits || []).find(function (a) {
        return normalizeBizNo(a.bizNo) === normalizeBizNo(v.bizNo) &&
          a.round === round && a.status !== AUDIT_STATUS.DRAFT;
      });
      if (audit) {
        (auditLines || []).forEach(function (l) { if (l.auditId === audit.id) totalLines.push(l); });
      }
    });
    var total = buildSummaryRow(totalLines, opts);
    total.vendorName = '합계';

    return { rows: all, total: total };
  }

  /**
   * 관리자가 결과 추출 전에 확인해야 하는 3가지를 한 번에 점검한다.
   * 요청 원문: "결과확인서 누락 없는지, 재고보정 대상은 없는지, 불일치는 없는지"
   */
  function buildPreflight(vendors, audits, auditLines, attachments, round) {
    var missingCert = [];
    var pendingCorrection = [];
    var mismatch = [];
    var notSubmitted = [];

    (vendors || []).forEach(function (v) {
      var status = vendorSubmissionStatus(audits, auditLines, v.bizNo, round);
      if (status === '미제출') { notSubmitted.push(v.name); return; }

      var audit = (audits || []).find(function (a) {
        return normalizeBizNo(a.bizNo) === normalizeBizNo(v.bizNo) &&
          a.round === round && a.status !== AUDIT_STATUS.DRAFT;
      });
      if (!audit) return;

      var hasCert = (attachments || []).some(function (t) { return t.auditId === audit.id; });
      if (!hasCert) missingCert.push(v.name);

      (auditLines || []).filter(function (l) { return l.auditId === audit.id; })
        .forEach(function (l) {
          if (!isCorrectionCandidate(l)) return;
          mismatch.push({ vendorName: v.name, itemName: l.itemName, diff: l.diff });
          // 불일치인데 보정 O/X 판단이 아직 안 된 라인
          if (!String(l.correction || '').trim()) {
            pendingCorrection.push({ vendorName: v.name, itemName: l.itemName, diff: l.diff });
          }
        });
    });

    return {
      notSubmitted: notSubmitted,
      missingCert: missingCert,
      mismatch: mismatch,
      pendingCorrection: pendingCorrection,
      ready: notSubmitted.length === 0 && missingCert.length === 0 && pendingCorrection.length === 0
    };
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
    DEFAULT_VENDOR_PASSWORD: DEFAULT_VENDOR_PASSWORD,
    analyzeVendorImport: analyzeVendorImport,
    computeMatchRates: computeMatchRates,
    vendorSubmissionStatus: vendorSubmissionStatus,
    buildDashboard: buildDashboard,
    // 2026-08-24 보완 — 마감·지각
    computeOverdue: computeOverdue,
    allSubmitted: allSubmitted,
    // 2026-08-24 보완 — 재고보정
    FAULT: FAULT,
    ACTION_CORRECTION: ACTION_CORRECTION,
    isCorrectionCandidate: isCorrectionCandidate,
    correctionAmount: correctionAmount,
    buildCorrectionList: buildCorrectionList,
    // 2026-08-24 보완 — 총괄표
    buildSummaryRow: buildSummaryRow,
    buildSummaryTable: buildSummaryTable,
    buildPreflight: buildPreflight,
    formatNumber: formatNumber,
    formatBizNo: formatBizNo
  };
});
