/**
 * report.js — 보고서 생성 및 기준 데이터 엑셀 임포트/내보내기 (SheetJS)
 */
(function (global) {
  'use strict';

  var Logic = global.Logic;

  /**
   * 보고서용 데이터 집계.
   * @returns {{round, generatedAt, overall, vendors: [{vendor, status, rates, lines, deleteLines}]}}
   */
  function buildReportData(db) {
    var round = db.round;
    var allCountedLines = [];
    var vendorSections = (db.vendors || []).map(function (v) {
      var status = Logic.vendorSubmissionStatus(db.audits, db.auditLines, v.bizNo, round);
      var audit = (db.audits || []).find(function (a) {
        return Logic.normalizeBizNo(a.bizNo) === Logic.normalizeBizNo(v.bizNo) &&
          a.round === round && a.status !== Logic.AUDIT_STATUS.DRAFT;
      });
      var lines = audit
        ? (db.auditLines || []).filter(function (l) { return l.auditId === audit.id; })
        : [];
      allCountedLines = allCountedLines.concat(lines);
      return {
        vendor: v,
        status: status,
        submittedAt: audit ? audit.submittedAt : null,
        rates: Logic.computeMatchRates(lines),
        lines: lines,
        deleteLines: lines.filter(function (l) { return l.deleteRequested; })
      };
    });
    return {
      round: round,
      generatedAt: new Date(),
      overall: Logic.computeMatchRates(allCountedLines),
      deleteLines: allCountedLines.filter(function (l) { return l.deleteRequested; }),
      vendors: vendorSections
    };
  }

  function pct(v) { return v === null || v === undefined ? '-' : v + '%'; }

  /**
   * 엑셀 보고서 생성 및 다운로드.
   * 구성: [요약] 표지 시트 + 업체별 시트.
   */
  function downloadExcelReport(db) {
    var XLSX = global.XLSX;
    if (!XLSX) {
      alert('엑셀 라이브러리(SheetJS)를 불러오지 못했습니다. 네트워크 연결을 확인해 주세요.');
      return;
    }

    var round = db.round;
    var plan = db.roundPlan || {};
    var bookBase = plan.bookBase || '전월';
    var vendors = db.vendors || [];
    var wb = XLSX.utils.book_new();

    // 보정 확정 라인은 상단 일치도에서 빼고 하단 보정요청 리스트로 보낸다.
    // 원본 총괄표가 그렇게 되어 있다(보정 2건인데 상단 일치율 100%).
    var table = Logic.buildSummaryTable(db.audits && db.vendors ? vendors : [],
      db.audits, db.auditLines, round, { excludeCorrected: true });

    var allLines = [];
    vendors.forEach(function (v) {
      var audit = (db.audits || []).find(function (a) {
        return Logic.normalizeBizNo(a.bizNo) === Logic.normalizeBizNo(v.bizNo) &&
          a.round === round && a.status !== Logic.AUDIT_STATUS.DRAFT;
      });
      if (!audit) return;
      (db.auditLines || []).forEach(function (l) { if (l.auditId === audit.id) allLines.push(l); });
    });

    // ============================================================
    // 시트 1 — 재고실사 총괄표 (상단 집계 + 하단 보정요청 리스트)
    // ============================================================
    var rows = [];
    rows.push(['● ' + round + ' 대여 아이템 자체재고실사 총괄표']);
    rows.push([]);
    rows.push(['단위 : 품목수, 원']);
    // 3단 머리글 — 원본 양식의 병합 구조를 평평하게 편 형태
    rows.push(['대여업체', bookBase + ' 마감 재고', '', '실사 대상(실사일 기준)', '', '',
               '실사결과', '', '', '', '', '', '', '', '비고']);
    rows.push(['', '', '', '', '', '', '품목기준', '', '', '', '금액기준', '', '', '', '']);
    rows.push(['', '품목수', '금액', '수량', '금액', '실사율',
               '일치', '과잉', '부족', '일치율',
               '일치', '과잉', '부족', 'NET', '일치율']);

    function pctCell(v) { return v === null || v === undefined ? '-' : v / 100; }

    table.rows.forEach(function (r) {
      rows.push([
        r.vendorName,
        r.bookLines, r.bookAmount,
        r.actualQty, r.actualAmount, pctCell(r.auditRate),
        r.matchQty, r.overQty, r.shortQty, pctCell(r.qtyMatchRate),
        r.matchAmount, r.overAmount, r.shortAmount, r.netAmount, pctCell(r.amountMatchRate),
        r.status === '미제출' ? '미제출' : ''
      ]);
    });
    var t = table.total;
    rows.push([
      '합계',
      t.bookLines, t.bookAmount,
      t.actualQty, t.actualAmount, pctCell(t.auditRate),
      t.matchQty, t.overQty, t.shortQty, pctCell(t.qtyMatchRate),
      t.matchAmount, t.overAmount, t.shortAmount, t.netAmount, pctCell(t.amountMatchRate),
      ''
    ]);
    rows.push([]);
    rows.push(['* 보정 확정 건은 위 일치도에서 제외하고 아래 보정요청 리스트로 집계합니다.']);
    rows.push([]);

    // ---------- 하단: 보정요청 리스트 ----------
    var corr = Logic.buildCorrectionList(vendors, allLines);
    rows.push(['보정요청 리스트']);
    rows.push(['단위 : 수량, 원']);
    rows.push(['대여업체', '품번', '품명', '보정수량', '보정금액', '귀책', '조치사항', '보정사유']);

    if (corr.rows.length === 0) {
      rows.push(['(보정 요청 없음)']);
    } else {
      // 업체가 바뀌는 지점에 소계를 끼워 넣는다 — 원본 양식과 같은 배치
      var curVendor = null;
      var subIdx = 0;
      corr.rows.forEach(function (c) {
        if (curVendor !== null && c.vendorName !== curVendor) {
          var st = corr.subtotals[subIdx++];
          rows.push([st.vendorName, '', '', st.correctionQty, st.correctionAmount, '', '', '']);
        }
        curVendor = c.vendorName;
        rows.push([c.vendorName, c.partNo, c.itemName, c.correctionQty, c.correctionAmount,
                   c.fault, c.action, c.reason]);
      });
      var last = corr.subtotals[subIdx];
      if (last) rows.push([last.vendorName, '', '', last.correctionQty, last.correctionAmount, '', '', '']);
      rows.push(['총계', '', '', corr.totalQty, corr.totalAmount, '', '', '']);
    }

    var wsSum = XLSX.utils.aoa_to_sheet(rows);
    wsSum['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 32 }, { wch: 12 }, { wch: 14 },
                      { wch: 10 }, { wch: 10 }, { wch: 40 }, { wch: 12 }, { wch: 10 },
                      { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 14 }];
    // 일치율·실사율 열을 퍼센트 서식으로. 값은 0~1 비율로 넣었다.
    ['F', 'J', 'O'].forEach(function (col) {
      for (var r = 7; r <= 7 + table.rows.length; r++) {
        var cell = wsSum[col + r];
        if (cell && typeof cell.v === 'number') cell.z = '0.0%';
      }
    });
    XLSX.utils.book_append_sheet(wb, wsSum, '재고실사 총괄표');

    // ============================================================
    // 시트 2 — 전체재고 (마스터 라인)
    // ============================================================
    var allRows = [[]];
    allRows.push(['순번', '업체번호', '업체명', '품번', '품명', '규격',
                  '전산재고', '실물재고', '차이', '발생사유', '처분방안',
                  '단가', '재고금액', '재고보정', '보정금액', '처리유형']);
    var seq = 0;
    vendors.forEach(function (v) {
      var audit = (db.audits || []).find(function (a) {
        return Logic.normalizeBizNo(a.bizNo) === Logic.normalizeBizNo(v.bizNo) &&
          a.round === round && a.status !== Logic.AUDIT_STATUS.DRAFT;
      });
      if (!audit) return;
      (db.auditLines || []).filter(function (l) { return l.auditId === audit.id; })
        .forEach(function (l) {
          seq++;
          var isCorr = String(l.correction || '').trim().toUpperCase() === 'O';
          allRows.push([
            seq, v.vendorCode || '', v.name, l.partNo || '', l.itemName, l.spec || '',
            l.bookQty, l.actualQty, l.diff,
            l.reason || '',
            l.deleteRequested ? '대여 종료 요청(' + (l.deleteStatus || '대기') + ')'
                              : (isCorr ? '재고보정' : ''),
            l.unitPrice, (Number(l.actualQty) || 0) * (Number(l.unitPrice) || 0),
            isCorr ? 'O' : '',
            isCorr ? Logic.correctionAmount(l) : 0,
            isCorr ? (l.action || Logic.ACTION_CORRECTION) : ''
          ]);
        });
    });
    var wsAll = XLSX.utils.aoa_to_sheet(allRows);
    wsAll['!cols'] = [{ wch: 6 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 24 }, { wch: 22 },
                      { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 40 }, { wch: 22 },
                      { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, wsAll, '전체재고');

    // ============================================================
    // 시트 3~ — 업체별
    // ============================================================
    vendors.forEach(function (v) {
      var audit = (db.audits || []).find(function (a) {
        return Logic.normalizeBizNo(a.bizNo) === Logic.normalizeBizNo(v.bizNo) &&
          a.round === round && a.status !== Logic.AUDIT_STATUS.DRAFT;
      });
      var lines = audit
        ? (db.auditLines || []).filter(function (l) { return l.auditId === audit.id; })
        : [];

      var vr = [[round + ' 대여 아이템 재고실사 — ' + v.name]];
      vr.push(['사업자번호', Logic.formatBizNo(v.bizNo), '업체번호', v.vendorCode || '-',
               '담당자', v.manager || '-']);
      vr.push(['제출 상태', Logic.vendorSubmissionStatus(db.audits, db.auditLines, v.bizNo, round),
               '제출일시', audit && audit.submittedAt ? String(audit.submittedAt).replace('T', ' ') : '-']);
      vr.push([]);
      vr.push(['순번', '품번', '품명', '규격', '전산재고', '실물재고', '차이',
               '단가', '재고금액', '발생사유', '처분방안', '재고보정']);
      if (lines.length === 0) {
        vr.push(['(제출된 실사 내역 없음)']);
      } else {
        lines.forEach(function (l, i) {
          var isCorr = String(l.correction || '').trim().toUpperCase() === 'O';
          vr.push([
            i + 1, l.partNo || '', l.itemName, l.spec || '',
            l.bookQty, l.actualQty, l.diff,
            l.unitPrice, (Number(l.actualQty) || 0) * (Number(l.unitPrice) || 0),
            l.reason || '',
            l.deleteRequested ? '대여 종료 요청(' + (l.deleteStatus || '대기') + ')'
                              : (isCorr ? '재고보정' : ''),
            isCorr ? 'O' : ''
          ]);
        });
      }
      var wsV = XLSX.utils.aoa_to_sheet(vr);
      wsV['!cols'] = [{ wch: 6 }, { wch: 16 }, { wch: 24 }, { wch: 22 }, { wch: 10 },
                      { wch: 10 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 40 },
                      { wch: 22 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(wb, wsV, safeSheetName(v.name, wb));
    });

    // ============================================================
    // 마지막 시트 — 결과확인서 제출 현황
    // ============================================================
    var certRows = [['결과확인서 제출 현황 — ' + round], []];
    certRows.push(['업체명', '사업자번호', '제출 상태', '확인서 파일명', '용량(KB)', '누락 여부']);
    vendors.forEach(function (v) {
      var audit = (db.audits || []).find(function (a) {
        return Logic.normalizeBizNo(a.bizNo) === Logic.normalizeBizNo(v.bizNo) &&
          a.round === round && a.status !== Logic.AUDIT_STATUS.DRAFT;
      });
      var att = audit
        ? (db.attachments || []).find(function (t) { return t.auditId === audit.id; })
        : null;
      var status = Logic.vendorSubmissionStatus(db.audits, db.auditLines, v.bizNo, round);
      certRows.push([
        v.name, Logic.formatBizNo(v.bizNo), status,
        att ? att.fileName : '',
        att ? Math.round((att.size || 0) / 1024) : '',
        status === '미제출' ? '미제출' : (att ? '' : '누락')
      ]);
    });
    var wsCert = XLSX.utils.aoa_to_sheet(certRows);
    wsCert['!cols'] = [{ wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 40 }, { wch: 10 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, wsCert, '결과확인서');

    XLSX.writeFile(wb, round + '_대여아이템_재고조사_총괄표.xlsx');
  }

  /**
   * 시트명 만들기 — 엑셀 제한(31자, `:\/?*[]` 금지)과 중복을 피한다.
   * 업체명이 길거나 겹치면 book_append_sheet가 조용히 실패하거나 덮어쓴다.
   */
  function safeSheetName(name, wb) {
    var base = String(name || '업체').replace(/[:\\\/?*\[\]]/g, ' ').slice(0, 28).trim() || '업체';
    var used = (wb.SheetNames || []);
    if (used.indexOf(base) < 0) return base;
    for (var i = 2; i < 100; i++) {
      var candidate = base.slice(0, 25) + '(' + i + ')';
      if (used.indexOf(candidate) < 0) return candidate;
    }
    return base.slice(0, 25) + '(x)';
  }

  // ---------------------------------------------------------------
  // 기준 데이터 관리 (업체/아이템 엑셀 임포트·내보내기)
  // ---------------------------------------------------------------

  /** 현재 기준 데이터(업체/아이템)를 엑셀로 내보내기 */
  function downloadMasterData(db) {
    var XLSX = global.XLSX;
    if (!XLSX) { alert('엑셀 라이브러리를 불러오지 못했습니다.'); return; }
    var wb = XLSX.utils.book_new();

    var vendorRows = [['사업자번호', '업체명', '담당자명', '연락처', '이메일', '비밀번호']];
    (db.vendors || []).forEach(function (v) {
      vendorRows.push([v.bizNo, v.name, v.manager, v.phone, v.email, v.password]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(vendorRows), '업체');

    var itemRows = [['아이템ID', '사업자번호', '아이템명', '규격', '대여수량', '단가', '금액', '대여일', '상태']];
    (db.items || []).forEach(function (i) {
      itemRows.push([i.id, i.bizNo, i.name, i.spec, i.qty, i.unitPrice, i.amount, i.rentedAt, i.status]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(itemRows), '아이템');

    XLSX.writeFile(wb, '기준데이터_업체_아이템.xlsx');
  }

  /**
   * 기준 데이터 엑셀 임포트.
   * "업체" / "아이템" 시트를 읽어 기존 기준 데이터를 대체한다.
   * 업체 시트는 임포트 전 중복 분석(Logic.analyzeVendorImport)을 거치며,
   * 기존 업체 덮어씀 또는 파일 내 중복이 있으면 confirmFn으로 사용자 확인을 받는다.
   * @param {File} file
   * @param {function(Error|null, {vendors:number, items:number, vendorAnalysis:object|null}=)} done
   * @param {function(string):boolean} [confirmFn]  확인 대화상자 (기본: window.confirm)
   */
  function importMasterData(db, file, done, confirmFn) {
    var XLSX = global.XLSX;
    if (!XLSX) { done(new Error('엑셀 라이브러리를 불러오지 못했습니다.')); return; }
    var ask = confirmFn || function (msg) { return global.confirm(msg); };
    var reader = new FileReader();
    reader.onerror = function () { done(new Error('파일을 읽지 못했습니다.')); };
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        var wsVendors = wb.Sheets['업체'];
        var wsItems = wb.Sheets['아이템'];
        if (!wsVendors && !wsItems) {
          done(new Error('"업체" 또는 "아이템" 시트를 찾을 수 없습니다. 내보내기 양식을 사용해 주세요.'));
          return;
        }
        var counts = { vendors: 0, items: 0, vendorAnalysis: null };
        if (wsVendors) {
          var vRows = XLSX.utils.sheet_to_json(wsVendors, { header: 1 }).slice(1);
          var vendorRows = vRows
            .filter(function (r) { return r && r[0]; })
            .map(function (r) {
              return {
                bizNo: Logic.normalizeBizNo(r[0]),
                name: String(r[1] || ''),
                manager: String(r[2] || ''),
                phone: String(r[3] || ''),
                email: String(r[4] || ''),
                password: String(r[5] || '') // 미입력은 분석 단계에서 기본값 적용·집계
              };
            });
          if (vendorRows.length > 0) {
            var analysis = Logic.analyzeVendorImport(db.vendors, vendorRows);
            if (analysis.overwriteCount > 0 || analysis.duplicateInFileCount > 0) {
              var msg = '업체 시트 임포트 확인\n\n' +
                '- 신규 ' + analysis.newCount + '건\n' +
                '- 기존 업체 덮어씀 ' + analysis.overwriteCount + '건\n' +
                '- 파일 내 사업자번호 중복 ' + analysis.duplicateInFileCount + '건 (마지막 행 적용)\n\n' +
                '기존 업체 목록은 파일 내용으로 교체됩니다. 계속할까요?';
              if (!ask(msg)) {
                done(new Error('임포트를 취소했습니다. 기준 데이터는 변경되지 않았습니다.'));
                return;
              }
            }
            db.vendors = analysis.vendors;
            counts.vendors = analysis.vendors.length;
            counts.vendorAnalysis = analysis;
          }
        }
        if (wsItems) {
          var iRows = XLSX.utils.sheet_to_json(wsItems, { header: 1 }).slice(1);
          var items = iRows
            .filter(function (r) { return r && r[0] && r[1]; })
            .map(function (r) {
              var qty = Number(r[4]) || 0;
              var unitPrice = Number(r[5]) || 0;
              return {
                id: String(r[0]),
                bizNo: Logic.normalizeBizNo(r[1]),
                name: String(r[2] || ''),
                spec: String(r[3] || ''),
                qty: qty,
                unitPrice: unitPrice,
                amount: qty * unitPrice,
                rentedAt: String(r[7] || ''),
                status: String(r[8] || '대여중')
              };
            });
          if (items.length > 0) { db.items = items; counts.items = items.length; }
        }
        done(null, counts);
      } catch (err) {
        done(new Error('엑셀 파일 해석에 실패했습니다: ' + err.message));
      }
    };
    reader.readAsArrayBuffer(file);
  }

  /**
   * 전월 마감 기준 전산재고 엑셀 읽기 (회차 관리 ①).
   *
   * 열 이름으로 찾는다 — 열 순서를 박아 두면 서식이 조금만 달라도 엉뚱한 값을 읽는다.
   * 품번 또는 아이템ID 중 하나, 그리고 장부수량(=전산재고)이 있으면 된다.
   *
   * @param {File} file
   * @param {function} done  (err, rows)  rows = [{partNo|itemId, qty, unitPrice?}]
   */
  function readBookStock(file, done) {
    var XLSX = global.XLSX;
    if (!XLSX) { done(new Error('엑셀 라이브러리(SheetJS)를 불러오지 못했습니다.')); return; }

    var reader = new FileReader();
    reader.onerror = function () { done(new Error('파일을 읽지 못했습니다.')); };
    reader.onload = function (ev) {
      try {
        var wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
        var rows = [];
        wb.SheetNames.forEach(function (name) {
          var json = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null });
          json.forEach(function (r) {
            var partNo = pick(r, ['품번', 'partNo', 'PART NO', '부품번호']);
            var itemId = pick(r, ['아이템ID', 'itemId', 'ID', '아이템 ID']);
            var qty = pick(r, ['전산재고', '장부수량', '수량', 'qty', '재고']);
            var price = pick(r, ['단가', 'unitPrice', '단가(원)']);
            if ((partNo === null && itemId === null) || qty === null) return;
            var n = Number(String(qty).replace(/,/g, ''));
            if (!isFinite(n)) return;
            rows.push({
              partNo: partNo === null ? undefined : String(partNo).trim(),
              itemId: itemId === null ? undefined : String(itemId).trim(),
              qty: n,
              unitPrice: price === null ? undefined : Number(String(price).replace(/,/g, ''))
            });
          });
        });
        done(null, rows);
      } catch (e) {
        done(e);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  /** 헤더 이름이 파일마다 갈려서 여러 후보로 찾는다. 공백·대소문자는 눌러서 비교한다. */
  function pick(row, names) {
    var norm = {};
    Object.keys(row).forEach(function (k) {
      norm[String(k).replace(/\s+/g, '').toLowerCase()] = row[k];
    });
    for (var i = 0; i < names.length; i++) {
      var key = String(names[i]).replace(/\s+/g, '').toLowerCase();
      if (norm[key] !== undefined && norm[key] !== null && norm[key] !== '') return norm[key];
    }
    return null;
  }

  global.Report = {
    buildReportData: buildReportData,
    downloadExcelReport: downloadExcelReport,
    downloadMasterData: downloadMasterData,
    importMasterData: importMasterData,
    readBookStock: readBookStock
  };
})(window);
