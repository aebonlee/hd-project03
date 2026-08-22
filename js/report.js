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
    var data = buildReportData(db);
    var wb = XLSX.utils.book_new();

    // ---------- 표지 요약 시트 ----------
    var summaryRows = [
      ['재고 실사 결과 보고서'],
      [],
      ['실사 회차', data.round],
      ['생성 일시', data.generatedAt.toLocaleString('ko-KR')],
      ['대상 업체 수', data.vendors.length + '개사'],
      [],
      ['■ 전체 요약'],
      ['전체 수량 일치도', pct(data.overall.qtyRate)],
      ['전체 금액 일치도', pct(data.overall.amountRate)],
      ['불일치 건수', data.overall.mismatchCount + '건'],
      ['삭제(대여 종료) 요청', data.overall.deleteCount + '건'],
      ['장부 수량 합계', data.overall.totalBookQty],
      ['실사 수량 합계', data.overall.totalActualQty],
      ['장부 금액 합계(원)', data.overall.totalBookAmount],
      ['금액 차이 합계(원)', data.overall.totalDiffAmount],
      [],
      ['■ 업체별 현황'],
      ['업체명', '사업자번호', '제출 상태', '수량 일치도', '금액 일치도', '불일치', '삭제요청', '제출일시']
    ];
    data.vendors.forEach(function (s) {
      summaryRows.push([
        s.vendor.name,
        Logic.formatBizNo(s.vendor.bizNo),
        s.status,
        s.status === '미제출' ? '-' : pct(s.rates.qtyRate),
        s.status === '미제출' ? '-' : pct(s.rates.amountRate),
        s.status === '미제출' ? '-' : s.rates.mismatchCount + '건',
        s.status === '미제출' ? '-' : s.rates.deleteCount + '건',
        s.submittedAt ? String(s.submittedAt).replace('T', ' ') : '-'
      ]);
    });
    summaryRows.push([]);
    summaryRows.push(['■ 삭제(대여 종료) 요청 내역']);
    summaryRows.push(['업체', '아이템', '장부수량', '단가(원)', '사유', '처리 상태']);
    if (data.deleteLines.length === 0) {
      summaryRows.push(['(요청 없음)']);
    } else {
      data.deleteLines.forEach(function (l) {
        var vendor = data.vendors.find(function (s) {
          return Logic.normalizeBizNo(s.vendor.bizNo) === Logic.normalizeBizNo(l.bizNo);
        });
        summaryRows.push([
          vendor ? vendor.vendor.name : l.bizNo,
          l.itemName, l.bookQty, l.unitPrice, l.reason, l.deleteStatus || '대기'
        ]);
      });
    }
    var wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    wsSummary['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, '요약');

    // ---------- 업체별 시트 ----------
    data.vendors.forEach(function (s) {
      var rows = [
        [s.vendor.name + ' — ' + data.round + ' 실사 결과'],
        ['사업자번호', Logic.formatBizNo(s.vendor.bizNo), '담당자', s.vendor.manager || '-'],
        ['제출 상태', s.status, '제출일시', s.submittedAt ? String(s.submittedAt).replace('T', ' ') : '-'],
        ['수량 일치도', s.status === '미제출' ? '-' : pct(s.rates.qtyRate), '금액 일치도', s.status === '미제출' ? '-' : pct(s.rates.amountRate)],
        [],
        ['아이템', '규격', '장부수량', '실사수량', '차이', '단가(원)', '금액차이(원)', '판정', '소명/사유', '삭제요청']
      ];
      if (s.lines.length === 0) {
        rows.push(['(제출된 실사 내역 없음)']);
      } else {
        s.lines.forEach(function (l) {
          rows.push([
            l.itemName, l.spec || '-', l.bookQty, l.actualQty, l.diff,
            l.unitPrice, l.amountDiff,
            l.deleteRequested ? '삭제요청' : (l.diff === 0 ? '일치' : '불일치'),
            l.reason || '', l.deleteRequested ? (l.deleteStatus || '대기') : ''
          ]);
        });
      }
      var ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 20 }, { wch: 20 }, { wch: 9 }, { wch: 9 }, { wch: 7 }, { wch: 11 }, { wch: 12 }, { wch: 9 }, { wch: 34 }, { wch: 9 }];
      // 시트명 31자 제한 대비
      XLSX.utils.book_append_sheet(wb, ws, s.vendor.name.slice(0, 28));
    });

    XLSX.writeFile(wb, '재고실사보고서_' + data.round + '.xlsx');
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

  global.Report = {
    buildReportData: buildReportData,
    downloadExcelReport: downloadExcelReport,
    downloadMasterData: downloadMasterData,
    importMasterData: importMasterData
  };
})(window);
