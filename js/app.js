/**
 * app.js — 화면 컨트롤러 (로그인 / 업체 실무자 / HD 담당자 / 보고서)
 */
(function (global) {
  'use strict';

  var Logic = global.Logic;
  var Store = global.Store;
  var Report = global.Report;

  var HD_PASSWORD = 'hd1234'; // 데모용 담당자 비밀번호
  var HD_EMAIL = 'hd-manager@hd.example.com';

  var state = {
    role: null,          // 'vendor' | 'hd'
    vendor: null,        // 로그인한 업체
    adminTab: 'dashboard',
    selectedAuditBizNo: null,
    pendingFile: null    // 업로드 대기 중 첨부 {fileName, size, type, preview}
  };

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmt(n) { return Logic.formatNumber(n); }

  // ---------------------------------------------------------------
  // 화면 전환
  // ---------------------------------------------------------------

  function showView(id) {
    $all('.view').forEach(function (v) { v.classList.remove('active'); });
    $('#' + id).classList.add('active');
    window.scrollTo(0, 0);
  }

  function updateTopbar() {
    var info = $('#user-info');
    var logoutBtn = $('#btn-logout');
    if (state.role === 'vendor' && state.vendor) {
      info.textContent = state.vendor.name + ' · ' + Logic.formatBizNo(state.vendor.bizNo) + ' (업체 실무자)';
      logoutBtn.hidden = false;
    } else if (state.role === 'hd') {
      info.textContent = 'HD 재고관리 담당자';
      logoutBtn.hidden = false;
    } else {
      info.textContent = '';
      logoutBtn.hidden = true;
    }
  }

  function logout() {
    state.role = null;
    state.vendor = null;
    state.pendingFile = null;
    state.selectedAuditBizNo = null;
    updateTopbar();
    renderLogin();
    showView('view-login');
  }

  // ---------------------------------------------------------------
  // 로그인 화면
  // ---------------------------------------------------------------

  function renderLogin() {
    var db = Store.load();
    var tbody = $('#demo-accounts');
    tbody.innerHTML = db.vendors.map(function (v) {
      return '<tr data-bizno="' + esc(v.bizNo) + '" data-pw="' + esc(v.password) + '">' +
        '<td>' + esc(v.name) + '</td>' +
        '<td class="mono">' + esc(Logic.formatBizNo(v.bizNo)) + '</td>' +
        '<td class="mono">' + esc(v.password) + '</td>' +
        '<td><button type="button" class="btn btn-sm btn-ghost">자동 입력</button></td></tr>';
    }).join('');
    $all('#demo-accounts tr').forEach(function (tr) {
      tr.querySelector('button').addEventListener('click', function () {
        $('#login-bizno').value = Logic.formatBizNo(tr.getAttribute('data-bizno'));
        $('#login-password').value = tr.getAttribute('data-pw');
      });
    });
  }

  function setLoginTab(tab) {
    $all('.login-tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    $('#login-vendor-panel').hidden = tab !== 'vendor';
    $('#login-hd-panel').hidden = tab !== 'hd';
  }

  function handleVendorLogin(e) {
    e.preventDefault();
    var db = Store.load();
    var vendor = Logic.authenticateVendor(db.vendors, $('#login-bizno').value, $('#login-password').value);
    var err = $('#login-vendor-error');
    if (!vendor) {
      err.textContent = '사업자번호 또는 비밀번호가 올바르지 않습니다.';
      return;
    }
    err.textContent = '';
    state.role = 'vendor';
    state.vendor = vendor;
    state.pendingFile = null;
    updateTopbar();
    renderVendorView();
    showView('view-vendor');
  }

  function handleHdLogin(e) {
    e.preventDefault();
    var err = $('#login-hd-error');
    if ($('#login-hd-password').value !== HD_PASSWORD) {
      err.textContent = '담당자 비밀번호가 올바르지 않습니다. (데모: ' + HD_PASSWORD + ')';
      return;
    }
    err.textContent = '';
    state.role = 'hd';
    updateTopbar();
    renderAdminView();
    showView('view-admin');
  }

  // ---------------------------------------------------------------
  // 업체 실무자 화면
  // ---------------------------------------------------------------

  /** 이번 회차 실사(작성중 포함) 조회, 없으면 작성중 실사 생성 */
  function getOrCreateVendorAudit(db, bizNo) {
    var audit = db.audits.find(function (a) {
      return Logic.normalizeBizNo(a.bizNo) === Logic.normalizeBizNo(bizNo) && a.round === db.round;
    });
    if (audit) return audit;
    audit = {
      id: 'AU-' + Logic.normalizeBizNo(bizNo).slice(0, 3) + '-' + db.round,
      bizNo: Logic.normalizeBizNo(bizNo),
      round: db.round,
      status: Logic.AUDIT_STATUS.DRAFT,
      submittedAt: null
    };
    db.audits.push(audit);
    // 권한 필터를 거친 본인 업체 아이템만 라인 생성 (업체 간 데이터 격리)
    Logic.filterByVendor(db.items, bizNo)
      .filter(function (i) { return i.status !== Logic.ITEM_STATUS.ENDED; })
      .forEach(function (item) {
        db.auditLines.push({
          auditId: audit.id,
          itemId: item.id,
          itemName: item.name,
          spec: item.spec,
          bizNo: item.bizNo,
          bookQty: item.qty,
          unitPrice: item.unitPrice,
          bookAmount: item.qty * item.unitPrice,
          actualQty: null,
          diff: null,
          amountDiff: null,
          reason: '',
          deleteRequested: false,
          deleteStatus: null
        });
      });
    Store.save();
    return audit;
  }

  function vendorLines(db, auditId) {
    // 이중 안전장치: 실사 ID + 사업자번호로 모두 필터
    return Logic.filterByVendor(db.auditLines, state.vendor.bizNo)
      .filter(function (l) { return l.auditId === auditId; });
  }

  function renderVendorView() {
    var db = Store.load();
    var vendor = state.vendor;
    var audit = getOrCreateVendorAudit(db, vendor.bizNo);
    var lines = vendorLines(db, audit.id);
    var submitted = audit.status !== Logic.AUDIT_STATUS.DRAFT;

    $('#vendor-title').textContent = vendor.name + ' — ' + db.round + ' 재고 실사';
    $('#vendor-sub').textContent = '담당자 ' + vendor.manager + ' · ' + Logic.formatBizNo(vendor.bizNo) +
      (submitted ? ' · 제출일시 ' + String(audit.submittedAt || '').replace('T', ' ') : '');

    // 상태 배지
    var badge = $('#vendor-status-badge');
    badge.textContent = audit.status;
    badge.className = 'badge ' + (audit.status === Logic.AUDIT_STATUS.APPROVED ? 'badge-approved' :
      submitted ? 'badge-submitted' : 'badge-draft');

    renderVendorTable(db, audit, lines, submitted);
    renderVendorSummary(lines);
    renderVendorAttachment(db, audit, submitted);

    $('#vendor-submit-area').hidden = submitted;
    $('#vendor-submitted-note').hidden = !submitted;
    if (submitted) {
      $('#vendor-submitted-note').textContent = audit.status === Logic.AUDIT_STATUS.APPROVED
        ? '이번 회차 실사가 승인 완료되었습니다. 수고하셨습니다.'
        : '이번 회차 실사 결과가 제출되었습니다. HD 담당자 검토 후 승인됩니다.';
    }
  }

  function renderVendorTable(db, audit, lines, submitted) {
    var tbody = $('#vendor-items');
    tbody.innerHTML = lines.map(function (l, idx) {
      var judged = l.deleteRequested ? '<span class="badge badge-delete">삭제요청</span>'
        : l.actualQty === null ? '<span class="badge badge-wait">입력 대기</span>'
          : l.diff === 0 ? '<span class="badge badge-match">일치</span>'
            : '<span class="badge badge-mismatch">불일치 (' + (l.diff > 0 ? '+' : '') + l.diff + ')</span>';
      var needReason = l.deleteRequested || (l.actualQty !== null && l.diff !== 0);
      var item = db.items.find(function (i) { return i.id === l.itemId; });
      return '<tr class="' + (l.deleteRequested ? 'row-delete' : '') + '">' +
        '<td>' + (idx + 1) + '</td>' +
        '<td><strong>' + esc(l.itemName) + '</strong><div class="muted">' + esc(l.spec || '') + '</div></td>' +
        '<td class="num">' + fmt(l.bookQty) + '</td>' +
        '<td class="num">' + fmt(l.unitPrice) + '</td>' +
        '<td class="num">' + fmt(l.bookAmount) + '</td>' +
        '<td class="mono">' + esc(item ? item.rentedAt : '') + '</td>' +
        '<td>' + (submitted
          ? '<span class="num-strong">' + (l.actualQty === null ? '-' : fmt(l.actualQty)) + '</span>'
          : '<input type="number" min="0" class="input-qty" data-idx="' + idx + '" value="' +
            (l.actualQty === null || l.deleteRequested ? '' : l.actualQty) + '"' +
            (l.deleteRequested ? ' disabled placeholder="삭제요청"' : '') + '>') + '</td>' +
        '<td>' + judged + '</td>' +
        '<td>' + (submitted
          ? '<span class="reason-text">' + esc(l.reason || '-') + '</span>'
          : '<input type="text" class="input-reason" data-idx="' + idx + '" value="' + esc(l.reason || '') + '"' +
            ' placeholder="' + (needReason ? (l.deleteRequested ? '삭제 요청 사유 (필수)' : '소명 사유 (필수)') : '불일치 시 필수') + '"' +
            (needReason ? '' : ' disabled') + '>') + '</td>' +
        '<td>' + (submitted
          ? (l.deleteRequested ? '<span class="badge badge-delete">' + esc(l.deleteStatus || '대기') + '</span>' : '-')
          : '<label class="chk"><input type="checkbox" class="input-delete" data-idx="' + idx + '"' +
            (l.deleteRequested ? ' checked' : '') + '> 삭제 요청</label>') + '</td>' +
        '</tr>';
    }).join('');

    if (submitted) return;

    // 입력 이벤트 바인딩
    $all('#vendor-items .input-qty').forEach(function (input) {
      input.addEventListener('input', function () {
        var l = lines[Number(input.getAttribute('data-idx'))];
        var computed = Logic.computeLine(
          { id: l.itemId, qty: l.bookQty, unitPrice: l.unitPrice },
          input.value, l.deleteRequested);
        l.actualQty = computed.actualQty;
        l.diff = computed.diff;
        l.amountDiff = computed.amountDiff;
        Store.save();
        renderVendorView();
        // 포커스 유지
        var again = document.querySelector('#vendor-items .input-qty[data-idx="' + input.getAttribute('data-idx') + '"]');
        if (again) { again.focus(); }
      });
    });
    $all('#vendor-items .input-reason').forEach(function (input) {
      input.addEventListener('change', function () {
        lines[Number(input.getAttribute('data-idx'))].reason = input.value;
        Store.save();
      });
    });
    $all('#vendor-items .input-delete').forEach(function (input) {
      input.addEventListener('change', function () {
        var l = lines[Number(input.getAttribute('data-idx'))];
        var computed = Logic.computeLine(
          { id: l.itemId, qty: l.bookQty, unitPrice: l.unitPrice },
          input.checked ? null : l.actualQty, input.checked);
        l.deleteRequested = input.checked;
        l.deleteStatus = input.checked ? '대기' : null;
        l.actualQty = input.checked ? 0 : null;
        l.diff = computed.diff;
        l.amountDiff = computed.amountDiff;
        if (!input.checked) { l.actualQty = null; l.diff = null; l.amountDiff = null; }
        Store.save();
        renderVendorView();
      });
    });
  }

  function renderVendorSummary(lines) {
    var rates = Logic.computeMatchRates(lines);
    $('#vendor-summary').innerHTML =
      card('입력 진행', rates.countedLines + ' / ' + rates.totalLines + '건') +
      card('수량 일치도', rates.qtyRate + '%') +
      card('금액 일치도', rates.amountRate + '%') +
      card('불일치', rates.mismatchCount + '건', rates.mismatchCount > 0 ? 'warn' : '') +
      card('삭제 요청', rates.deleteCount + '건', rates.deleteCount > 0 ? 'warn' : '');
  }

  function card(label, value, cls) {
    return '<div class="stat-card ' + (cls || '') + '"><div class="stat-label">' + esc(label) +
      '</div><div class="stat-value">' + esc(value) + '</div></div>';
  }

  function renderVendorAttachment(db, audit, submitted) {
    var box = $('#vendor-attachment-info');
    var saved = db.attachments.find(function (a) { return a.auditId === audit.id; });
    var att = submitted ? saved : (state.pendingFile || saved);
    $('#vendor-file-row').hidden = submitted;
    if (att) {
      box.innerHTML = '<div class="file-chip">📎 ' + esc(att.fileName) +
        ' <span class="muted">(' + fmt(Math.round(att.size / 1024)) + ' KB)</span></div>' +
        (att.preview ? '<img class="file-preview" src="' + att.preview + '" alt="확인서 미리보기">' : '');
    } else {
      box.innerHTML = '<p class="muted">실사결과 확인서(PDF/JPG/PNG, 최대 10MB)를 첨부해 주세요. 제출 시 필수입니다.</p>';
    }
  }

  function handleFileSelect(e) {
    var file = e.target.files[0];
    var err = $('#vendor-file-error');
    err.textContent = '';
    if (!file) return;
    var check = Logic.validateFile(file.name, file.size);
    if (!check.ok) {
      err.textContent = check.error;
      e.target.value = '';
      return;
    }
    var att = { fileName: file.name, size: file.size, type: file.type, preview: null };
    // 이미지이고 1.5MB 이하일 때만 미리보기 저장 (localStorage 용량 보호)
    if (/^image\//.test(file.type) && file.size <= 1.5 * 1024 * 1024) {
      var reader = new FileReader();
      reader.onload = function (ev) {
        att.preview = ev.target.result;
        state.pendingFile = att;
        renderVendorView();
      };
      reader.readAsDataURL(file);
    } else {
      state.pendingFile = att;
      renderVendorView();
    }
  }

  function handleVendorSubmit() {
    var db = Store.load();
    var audit = getOrCreateVendorAudit(db, state.vendor.bizNo);
    var lines = vendorLines(db, audit.id);
    var saved = db.attachments.find(function (a) { return a.auditId === audit.id; });
    var att = state.pendingFile || saved;

    var result = Logic.validateSubmission(lines, att);
    var errBox = $('#vendor-submit-errors');
    if (!result.ok) {
      errBox.innerHTML = '<strong>제출할 수 없습니다.</strong><ul>' +
        result.errors.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>';
      errBox.hidden = false;
      return;
    }
    errBox.hidden = true;

    // 첨부 저장
    if (state.pendingFile && !saved) {
      db.attachments.push(Object.assign({ auditId: audit.id }, state.pendingFile));
    }
    // 아이템 상태 반영 (삭제 요청 → 종료요청)
    lines.forEach(function (l) {
      if (l.deleteRequested) {
        var item = db.items.find(function (i) { return i.id === l.itemId; });
        if (item) item.status = Logic.ITEM_STATUS.END_REQUESTED;
      }
    });
    audit.status = Logic.AUDIT_STATUS.SUBMITTED;
    audit.submittedAt = new Date().toISOString().slice(0, 19);
    Store.save();

    // 담당자 알림 (이메일 어댑터 → 알림 로그)
    var rates = Logic.computeMatchRates(lines);
    Store.notify(HD_EMAIL, '[실사 제출] ' + state.vendor.name + '(' + Logic.formatBizNo(state.vendor.bizNo) +
      ')가 ' + db.round + ' 실사 결과를 제출했습니다. (불일치 ' + rates.mismatchCount +
      '건, 삭제 요청 ' + rates.deleteCount + '건)');

    state.pendingFile = null;
    renderVendorView();
    alert('실사 결과가 제출되었습니다. HD 담당자에게 알림이 발송되었습니다.');
  }

  // ---------------------------------------------------------------
  // HD 담당자 화면
  // ---------------------------------------------------------------

  function setAdminTab(tab) {
    state.adminTab = tab;
    $all('.admin-tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    $('#admin-dashboard').hidden = tab !== 'dashboard';
    $('#admin-notifications').hidden = tab !== 'notifications';
    $('#admin-master').hidden = tab !== 'master';
    renderAdminView();
  }

  function renderAdminView() {
    if (state.adminTab === 'dashboard') renderDashboard();
    else if (state.adminTab === 'notifications') renderNotifications();
    else renderMaster();
  }

  function statusBadge(status) {
    var cls = { '미제출': 'badge-wait', '제출': 'badge-submitted', '불일치 있음': 'badge-mismatch', '승인 완료': 'badge-approved' }[status] || 'badge-wait';
    return '<span class="badge ' + cls + '">' + esc(status) + '</span>';
  }

  function renderDashboard() {
    var db = Store.load();
    var dash = Logic.buildDashboard(db.vendors, db.audits, db.auditLines, db.round);

    $('#admin-round').textContent = db.round + ' 실사 회차';
    $('#dash-cards').innerHTML =
      card('대상 업체', dash.summary.total + '개사') +
      card('미제출', dash.summary.notSubmitted + '개사', dash.summary.notSubmitted > 0 ? 'warn' : '') +
      card('제출', dash.summary.submitted + '개사') +
      card('불일치 있음', dash.summary.mismatch + '개사', dash.summary.mismatch > 0 ? 'warn' : '') +
      card('승인 완료', dash.summary.approved + '개사', 'ok');

    $('#dash-rows').innerHTML = dash.rows.map(function (r) {
      var selected = state.selectedAuditBizNo === r.bizNo;
      return '<tr class="clickable ' + (selected ? 'selected' : '') + '" data-bizno="' + esc(r.bizNo) + '">' +
        '<td><strong>' + esc(r.vendorName) + '</strong></td>' +
        '<td class="mono">' + esc(Logic.formatBizNo(r.bizNo)) + '</td>' +
        '<td>' + statusBadge(r.status) + '</td>' +
        '<td class="num">' + (r.qtyRate === null ? '-' : r.qtyRate + '%') + '</td>' +
        '<td class="num">' + (r.amountRate === null ? '-' : r.amountRate + '%') + '</td>' +
        '<td class="num">' + (r.mismatchCount === null ? '-' : r.mismatchCount + '건') + '</td>' +
        '<td class="num">' + (r.deleteCount === null ? '-' : r.deleteCount + '건') + '</td>' +
        '<td class="mono">' + (r.submittedAt ? esc(String(r.submittedAt).replace('T', ' ')) : '-') + '</td>' +
        '</tr>';
    }).join('');
    $all('#dash-rows tr').forEach(function (tr) {
      tr.addEventListener('click', function () {
        state.selectedAuditBizNo = tr.getAttribute('data-bizno');
        renderDashboard();
      });
    });

    renderAuditDetail(db);
  }

  function renderAuditDetail(db) {
    var panel = $('#audit-detail');
    var bizNo = state.selectedAuditBizNo;
    if (!bizNo) {
      panel.innerHTML = '<p class="muted">업체 행을 클릭하면 제출 상세를 검토할 수 있습니다.</p>';
      return;
    }
    var vendor = db.vendors.find(function (v) { return Logic.normalizeBizNo(v.bizNo) === Logic.normalizeBizNo(bizNo); });
    var audit = db.audits.find(function (a) {
      return Logic.normalizeBizNo(a.bizNo) === Logic.normalizeBizNo(bizNo) &&
        a.round === db.round && a.status !== Logic.AUDIT_STATUS.DRAFT;
    });
    if (!vendor) { panel.innerHTML = ''; return; }
    if (!audit) {
      panel.innerHTML = '<h3>' + esc(vendor.name) + '</h3><p class="muted">아직 제출된 실사 결과가 없습니다. (미제출)</p>' +
        '<button type="button" class="btn btn-ghost" id="btn-remind">제출 독려 알림 보내기</button>';
      var remind = $('#btn-remind');
      if (remind) remind.addEventListener('click', function () {
        Store.notify(vendor.email, '[실사 요청] ' + vendor.name + ' — ' + db.round +
          ' 재고 실사 결과를 아직 제출하지 않으셨습니다. 기한 내 제출 부탁드립니다.');
        alert('독려 알림을 발송했습니다. (알림 로그 확인)');
      });
      return;
    }
    var lines = db.auditLines.filter(function (l) { return l.auditId === audit.id; });
    var rates = Logic.computeMatchRates(lines);
    var att = db.attachments.find(function (a) { return a.auditId === audit.id; });

    var html = '<div class="detail-head"><h3>' + esc(vendor.name) + ' — 제출 상세</h3>' +
      statusBadge(audit.status === Logic.AUDIT_STATUS.APPROVED ? '승인 완료' : (rates.mismatchCount + rates.deleteCount > 0 ? '불일치 있음' : '제출')) + '</div>' +
      '<p class="muted">제출일시 ' + esc(String(audit.submittedAt || '').replace('T', ' ')) +
      ' · 수량 일치도 <strong>' + rates.qtyRate + '%</strong> · 금액 일치도 <strong>' + rates.amountRate + '%</strong>' +
      ' · 금액 차이 합계 <strong>' + fmt(rates.totalDiffAmount) + '원</strong></p>';

    html += '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>아이템</th><th class="num">장부</th><th class="num">실사</th><th class="num">차이</th>' +
      '<th class="num">금액차이(원)</th><th>판정</th><th>소명/사유</th><th>삭제 요청</th></tr></thead><tbody>' +
      lines.map(function (l, i) {
        var judged = l.deleteRequested ? '<span class="badge badge-delete">삭제요청</span>'
          : l.diff === 0 ? '<span class="badge badge-match">일치</span>'
            : '<span class="badge badge-mismatch">불일치</span>';
        var delCell = '-';
        if (l.deleteRequested) {
          if (l.deleteStatus === '대기' && audit.status !== Logic.AUDIT_STATUS.APPROVED) {
            delCell = '<div class="btn-group">' +
              '<button type="button" class="btn btn-sm btn-primary btn-del-approve" data-idx="' + i + '">승인</button>' +
              '<button type="button" class="btn btn-sm btn-danger btn-del-reject" data-idx="' + i + '">반려</button></div>';
          } else {
            delCell = '<span class="badge ' + (l.deleteStatus === '승인' ? 'badge-approved' : l.deleteStatus === '반려' ? 'badge-mismatch' : 'badge-wait') + '">' + esc(l.deleteStatus || '대기') + '</span>';
          }
        }
        return '<tr>' +
          '<td><strong>' + esc(l.itemName) + '</strong><div class="muted">' + esc(l.spec || '') + '</div></td>' +
          '<td class="num">' + fmt(l.bookQty) + '</td>' +
          '<td class="num">' + fmt(l.actualQty) + '</td>' +
          '<td class="num">' + (l.diff > 0 ? '+' : '') + fmt(l.diff) + '</td>' +
          '<td class="num">' + fmt(l.amountDiff) + '</td>' +
          '<td>' + judged + '</td>' +
          '<td class="reason-text">' + esc(l.reason || '-') + '</td>' +
          '<td>' + delCell + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    html += '<div class="detail-foot">';
    html += att
      ? '<div class="file-chip">📎 첨부 확인서: ' + esc(att.fileName) + ' <span class="muted">(' + fmt(Math.round(att.size / 1024)) + ' KB)</span></div>' +
        (att.preview ? '<img class="file-preview" src="' + att.preview + '" alt="확인서 미리보기">' : '')
      : '<p class="muted">첨부 확인서 없음</p>';
    var pendingDeletes = lines.some(function (l) { return l.deleteRequested && l.deleteStatus === '대기'; });
    if (audit.status !== Logic.AUDIT_STATUS.APPROVED) {
      html += '<div class="btn-group">' +
        '<button type="button" class="btn btn-primary" id="btn-approve-audit"' + (pendingDeletes ? ' disabled title="삭제 요청을 먼저 승인/반려해 주세요"' : '') + '>실사 승인</button>' +
        (pendingDeletes ? '<span class="muted">삭제 요청 처리 후 승인할 수 있습니다.</span>' : '') + '</div>';
    }
    html += '</div>';
    panel.innerHTML = html;

    $all('#audit-detail .btn-del-approve').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var l = lines[Number(btn.getAttribute('data-idx'))];
        l.deleteStatus = '승인';
        var item = db.items.find(function (i) { return i.id === l.itemId; });
        if (item) item.status = Logic.ITEM_STATUS.ENDED;
        Store.save();
        Store.notify(vendor.email, '[삭제 승인] ' + vendor.name + ' — "' + l.itemName + '" 대여 종료 요청이 승인되었습니다.');
        renderDashboard();
      });
    });
    $all('#audit-detail .btn-del-reject').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var l = lines[Number(btn.getAttribute('data-idx'))];
        l.deleteStatus = '반려';
        var item = db.items.find(function (i) { return i.id === l.itemId; });
        if (item) item.status = Logic.ITEM_STATUS.RENTED;
        Store.save();
        Store.notify(vendor.email, '[삭제 반려] ' + vendor.name + ' — "' + l.itemName + '" 대여 종료 요청이 반려되었습니다. 사유 확인 후 재실사 바랍니다.');
        renderDashboard();
      });
    });
    var approveBtn = $('#btn-approve-audit');
    if (approveBtn) {
      approveBtn.addEventListener('click', function () {
        audit.status = Logic.AUDIT_STATUS.APPROVED;
        Store.save();
        Store.notify(vendor.email, '[실사 승인] ' + vendor.name + ' ' + db.round + ' 실사 결과가 승인되었습니다.');
        renderDashboard();
      });
    }
  }

  function renderNotifications() {
    var db = Store.load();
    var list = db.notifications.slice().reverse();
    $('#notification-list').innerHTML = list.length === 0
      ? '<p class="muted">알림 이력이 없습니다.</p>'
      : list.map(function (n) {
        return '<div class="notif"><div class="notif-meta"><span class="badge badge-wait">' + esc(n.channel) +
          '</span> <span class="mono">' + esc(String(n.sentAt).replace('T', ' ')) + '</span> → ' + esc(n.to) +
          '</div><div class="notif-body">' + esc(n.message) + '</div></div>';
      }).join('');
  }

  function renderMaster() {
    var db = Store.load();
    $('#master-summary').textContent = '현재 기준 데이터: 업체 ' + db.vendors.length + '개사, 아이템 ' + db.items.length + '건';
    $('#master-items').innerHTML = db.items.map(function (i) {
      var v = db.vendors.find(function (x) { return Logic.normalizeBizNo(x.bizNo) === Logic.normalizeBizNo(i.bizNo); });
      return '<tr><td class="mono">' + esc(i.id) + '</td><td>' + esc(v ? v.name : i.bizNo) + '</td>' +
        '<td>' + esc(i.name) + '</td><td class="muted">' + esc(i.spec) + '</td>' +
        '<td class="num">' + fmt(i.qty) + '</td><td class="num">' + fmt(i.unitPrice) + '</td>' +
        '<td class="num">' + fmt(i.amount) + '</td><td class="mono">' + esc(i.rentedAt) + '</td>' +
        '<td>' + esc(i.status) + '</td></tr>';
    }).join('');
  }

  function handleMasterImport(e) {
    var file = e.target.files[0];
    if (!file) return;
    var db = Store.load();
    Report.importMasterData(db, file, function (err, counts) {
      e.target.value = '';
      if (err) { alert(err.message); return; }
      Store.save();
      alert('임포트 완료 — 업체 ' + counts.vendors + '건, 아이템 ' + counts.items + '건을 반영했습니다.');
      renderMaster();
    });
  }

  // ---------------------------------------------------------------
  // 보고서 (인쇄용 PDF 뷰)
  // ---------------------------------------------------------------

  function renderPrintReport() {
    var db = Store.load();
    var data = Report.buildReportData(db);
    var o = data.overall;
    var html = '<div class="report-cover">' +
      '<h1>재고 실사 결과 보고서</h1>' +
      '<p class="report-meta">실사 회차: <strong>' + esc(data.round) + '</strong> · 생성일시: ' +
      esc(data.generatedAt.toLocaleString('ko-KR')) + ' · 대상 업체 ' + data.vendors.length + '개사</p>' +
      '<div class="stat-grid">' +
      card('전체 수량 일치도', o.qtyRate + '%') +
      card('전체 금액 일치도', o.amountRate + '%') +
      card('불일치 건수', o.mismatchCount + '건', o.mismatchCount > 0 ? 'warn' : '') +
      card('삭제 요청', o.deleteCount + '건', o.deleteCount > 0 ? 'warn' : '') +
      '</div>' +
      '<table class="table"><thead><tr><th>구분</th><th class="num">장부</th><th class="num">실사</th><th class="num">차이(절대값 합)</th></tr></thead><tbody>' +
      '<tr><td>수량 합계</td><td class="num">' + fmt(o.totalBookQty) + '</td><td class="num">' + fmt(o.totalActualQty) + '</td><td class="num">' + fmt(o.totalDiffQty) + '</td></tr>' +
      '<tr><td>금액 합계(원)</td><td class="num">' + fmt(o.totalBookAmount) + '</td><td class="num">' + fmt(o.totalBookAmount - o.totalDiffAmount) + '</td><td class="num">' + fmt(o.totalDiffAmount) + '</td></tr>' +
      '</tbody></table></div>';

    html += '<h2>삭제(대여 종료) 요청 내역</h2>';
    html += data.deleteLines.length === 0 ? '<p class="muted">요청 없음</p>'
      : '<table class="table"><thead><tr><th>아이템</th><th class="num">장부수량</th><th class="num">단가(원)</th><th>사유</th><th>처리 상태</th></tr></thead><tbody>' +
        data.deleteLines.map(function (l) {
          return '<tr><td>' + esc(l.itemName) + '</td><td class="num">' + fmt(l.bookQty) + '</td>' +
            '<td class="num">' + fmt(l.unitPrice) + '</td><td>' + esc(l.reason) + '</td><td>' + esc(l.deleteStatus || '대기') + '</td></tr>';
        }).join('') + '</tbody></table>';

    data.vendors.forEach(function (s) {
      html += '<div class="report-vendor"><h2>' + esc(s.vendor.name) +
        ' <span class="mono muted">' + esc(Logic.formatBizNo(s.vendor.bizNo)) + '</span></h2>';
      if (s.status === '미제출') {
        html += '<p class="muted">미제출 — 이번 회차 실사 결과가 접수되지 않았습니다.</p></div>';
        return;
      }
      html += '<p class="muted">상태 ' + esc(s.status) + ' · 수량 일치도 <strong>' + s.rates.qtyRate +
        '%</strong> · 금액 일치도 <strong>' + s.rates.amountRate + '%</strong> · 불일치 ' + s.rates.mismatchCount + '건</p>' +
        '<table class="table"><thead><tr><th>아이템</th><th>규격</th><th class="num">장부</th><th class="num">실사</th>' +
        '<th class="num">차이</th><th class="num">금액차이(원)</th><th>판정</th><th>소명/사유</th></tr></thead><tbody>' +
        s.lines.map(function (l) {
          return '<tr><td>' + esc(l.itemName) + '</td><td class="muted">' + esc(l.spec || '') + '</td>' +
            '<td class="num">' + fmt(l.bookQty) + '</td><td class="num">' + fmt(l.actualQty) + '</td>' +
            '<td class="num">' + (l.diff > 0 ? '+' : '') + fmt(l.diff) + '</td><td class="num">' + fmt(l.amountDiff) + '</td>' +
            '<td>' + (l.deleteRequested ? '삭제요청' : l.diff === 0 ? '일치' : '불일치') + '</td>' +
            '<td>' + esc(l.reason || '-') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    });

    $('#report-body').innerHTML = html;
    showView('view-report');
  }

  // ---------------------------------------------------------------
  // 초기화
  // ---------------------------------------------------------------

  function init() {
    Store.load();

    // 로그인
    $all('.login-tab').forEach(function (b) {
      b.addEventListener('click', function () { setLoginTab(b.getAttribute('data-tab')); });
    });
    $('#form-vendor-login').addEventListener('submit', handleVendorLogin);
    $('#form-hd-login').addEventListener('submit', handleHdLogin);
    $('#btn-logout').addEventListener('click', logout);

    // 데모 데이터 초기화
    $all('.btn-reset-demo').forEach(function (b) {
      b.addEventListener('click', function () {
        if (confirm('데모 데이터를 초기 상태로 되돌립니다. 계속할까요?')) {
          Store.reset();
          state.pendingFile = null;
          state.selectedAuditBizNo = null;
          if (state.role === 'vendor') renderVendorView();
          else if (state.role === 'hd') renderAdminView();
          else renderLogin();
          alert('데모 데이터가 초기화되었습니다.');
        }
      });
    });

    // 업체 화면
    $('#vendor-file').addEventListener('change', handleFileSelect);
    $('#btn-vendor-submit').addEventListener('click', handleVendorSubmit);

    // 담당자 화면
    $all('.admin-tab').forEach(function (b) {
      b.addEventListener('click', function () { setAdminTab(b.getAttribute('data-tab')); });
    });
    $('#btn-report').addEventListener('click', function () {
      renderPrintReport();
    });
    $('#btn-report-excel').addEventListener('click', function () {
      Report.downloadExcelReport(Store.load());
    });
    $('#btn-master-export').addEventListener('click', function () {
      Report.downloadMasterData(Store.load());
    });
    $('#master-import').addEventListener('change', handleMasterImport);

    // 보고서 화면
    $('#btn-print').addEventListener('click', function () { window.print(); });
    $('#btn-report-back').addEventListener('click', function () {
      showView('view-admin');
      renderAdminView();
    });
    $('#btn-report-excel-2').addEventListener('click', function () {
      Report.downloadExcelReport(Store.load());
    });

    renderLogin();
    setLoginTab('vendor');
    showView('view-login');
  }

  document.addEventListener('DOMContentLoaded', init);
})(window);
