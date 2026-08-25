/**
 * app.js — 화면 컨트롤러 (로그인 / 업체 실무자 / HD 담당자 / 보고서)
 */
(function (global) {
  'use strict';

  var Logic = global.Logic;
  var Store = global.Store;
  var Report = global.Report;

  // =================================================================
  // ⚠ DEMO CONFIG — 데모 전용 하드코딩 인증 정보 (여기 한 곳에서만 관리)
  //
  // 아래 값은 과정 실습용 데모를 위한 것으로, 로그인 화면에도 그대로
  // 노출됩니다. 실제 배포 전에는 반드시 Supabase Auth 등 실제 인증으로
  // 교체해야 합니다. (README "Supabase 전환 가이드" 참조)
  // =================================================================
  var DEMO_CONFIG = {
    HD_PASSWORD: 'hd1234',                      // 데모용 담당자 비밀번호
    HD_EMAIL: 'hd-manager@hd.example.com'       // 데모용 담당자 알림 수신 주소
  };
  var HD_PASSWORD = DEMO_CONFIG.HD_PASSWORD;
  var HD_EMAIL = DEMO_CONFIG.HD_EMAIL;

  /**
   * 저장 위치.
   *   데모 모드 : js/store.js  — 이 브라우저에만
   *   서버 모드 : js/supabase-store.js — 업체가 각자 접속해 자기 것만 본다
   * 화면 코드는 `Store` 하나만 보고 쓰므로 아래 한 줄만 바뀐다.
   */
  var Store = window.Store;
  var SERVER = false;

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
    // 서버 모드에서는 세션도 끊는다. 안 끊으면 새로고침만 해도 다시 들어가진다 —
    // 공용 PC 에서 다음 사람이 앞사람의 자료를 본다.
    if (SERVER && window.SupabaseStore) {
      window.SupabaseStore.signOut().then(function () { location.reload(); });
    }
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
    // 서버 모드에는 화면에 뿌릴 데모 계정이 없다. 있어서도 안 된다 —
    // 업체 목록 자체가 남의 자료라, 로그인 전에 보여 주면 격리가 무너진다.
    if (SERVER) return;
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
    var err = $('#login-vendor-error');
    var bizNo = String($('#login-bizno').value || '').replace(/[^0-9]/g, '');
    var pw = $('#login-password').value;

    if (SERVER) {
      // 서버 모드에서는 **DB 가 판정한다.** 화면이 업체 목록을 들고 비교하면,
      // 그 목록 자체가 남의 자료라 격리가 무너진다.
      err.textContent = '확인 중…';
      window.SupabaseStore.signInVendor(bizNo, pw)
        .then(function () { return window.SupabaseStore.boot(Store.ROUND || window.Store.ROUND); })
        .then(function (doc) {
          var v = doc.vendors.filter(function (x) { return x.bizNo === bizNo; })[0];
          if (!v) {
            err.textContent = '로그인은 되었지만 이 계정에 연결된 업체가 없습니다. '
              + '담당자에게 vendor.auth_user_id 등록을 요청하세요.';
            return;
          }
          err.textContent = '';
          state.role = 'vendor'; state.vendor = v; state.pendingFile = null;
          updateTopbar(); renderVendorView(); showView('view-vendor');
        })
        .catch(function (e2) {
          err.textContent = '로그인하지 못했습니다 — ' + ((e2 && e2.message) || e2);
        });
      return;
    }

    var db = Store.load();
    var vendor = Logic.authenticateVendor(db.vendors, $('#login-bizno').value, pw);
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

    if (SERVER) {
      // 담당자는 이메일 + 비밀번호로 로그인하고, 관리자인지는 **DB 가 답한다**
      // (hd_manager 표에 있는가). 화면이 비밀번호를 비교하면 우회된다.
      var email = ($('#login-hd-email') && $('#login-hd-email').value) || '';
      err.textContent = '확인 중…';
      window.SupabaseStore.signInManager(email.trim(), $('#login-hd-password').value)
        .then(function () { return window.SupabaseStore.boot(Store.ROUND || window.Store.ROUND); })
        .then(function () {
          if (window.SupabaseStore.whoami().role !== 'hd') {
            err.textContent = '이 계정은 담당자로 등록되어 있지 않습니다. '
              + 'hd_manager 표에 등록이 필요합니다.';
            return;
          }
          err.textContent = '';
          state.role = 'hd';
          updateTopbar(); renderAdminView(); showView('view-admin');
        })
        .catch(function (e2) {
          err.textContent = '로그인하지 못했습니다 — ' + ((e2 && e2.message) || e2);
        });
      return;
    }

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

    renderDueBanner(db, audit, submitted);
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

  /**
   * 등록 마감 안내 / 지각 헤드라인.
   *
   * 요청 원문: "기 일자를 넘기는 업체는 접속시 상단에 빨간 헤드라인
   * (혹은 노란 헤드라인에 빨간색 글씨)으로 지각일수가 표시되면 좋겠습니다"
   *  → 기본은 노란 바탕 + 빨간 글씨, 7일 넘게 늦으면 빨간 바탕으로 한 단계 올린다.
   */
  function renderDueBanner(db, audit, submitted) {
    var el = $('#vendor-due-banner');
    if (!el) return;

    var plan = Store.roundPlan();
    var o = Logic.computeOverdue(plan.dueDate, new Date(), submitted, audit.submittedAt);

    if (o.state === '마감없음') { el.className = 'due-banner hidden'; el.innerHTML = ''; return; }

    var cls, html;
    if (o.state === '지각') {
      cls = o.days >= 7 ? 'is-late-hard' : 'is-late';
      html = '<strong>등록 기한이 지났습니다.</strong> '
        + '<span class="days">' + o.days + '일 지각</span><br>'
        + '등록 마감일은 <strong>' + esc(o.dueDate) + '</strong>이었습니다. '
        + '실사 결과와 결과확인서를 지금 등록해 주세요.';
    } else if (o.state === '임박') {
      cls = 'is-soon';
      html = o.days === 0
        ? '<strong>오늘이 등록 마감일입니다.</strong> (' + esc(o.dueDate) + ') 오늘 안에 등록해 주세요.'
        : '<strong>등록 마감이 ' + o.days + '일 남았습니다.</strong> (마감 ' + esc(o.dueDate) + ')';
    } else if (o.state === '여유') {
      cls = 'is-ok';
      html = '등록 마감일은 <strong>' + esc(o.dueDate) + '</strong>입니다. (' + o.days + '일 남음)';
    } else if (o.state === '지각제출') {
      // 이미 냈어도 며칠 늦었는지는 남긴다 — 다음 회차 독려의 근거가 된다
      cls = 'is-done-late';
      html = '제출이 완료되었습니다. 다만 마감일(' + esc(o.dueDate) + ')보다 '
        + '<strong>' + o.days + '일 늦은 제출</strong>이었습니다.';
    } else {
      cls = 'is-done';
      html = '기한 내 제출이 완료되었습니다. (마감 ' + esc(o.dueDate) + ')';
    }

    el.className = 'due-banner ' + cls;
    el.innerHTML = html;
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
        (att.preview ? '<img class="file-preview" src="' + esc(att.preview) + '" alt="확인서 미리보기">' : '');
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

    // 지각 제출이면 그 사실을 알림에 남긴다 — 다음 회차 독려의 근거가 된다
    var plan = Store.roundPlan();
    var od = Logic.computeOverdue(plan.dueDate, new Date(), true, audit.submittedAt);
    if (od.state === '지각제출') {
      Store.notify(HD_EMAIL, '[지각 제출] ' + state.vendor.name + ' — 마감일(' + od.dueDate +
        ')보다 ' + od.days + '일 늦게 제출했습니다.');
    }

    // 전 업체가 등록을 마쳤으면 담당자에게 통지 (회차당 1회)
    var allDone = notifyIfAllSubmitted(db);

    state.pendingFile = null;
    renderVendorView();
    alert('실사 결과가 제출되었습니다. HD 담당자에게 알림이 발송되었습니다.'
      + (allDone ? '\n\n이번 회차 전 업체 등록이 완료되어 담당자에게 완료 통지가 함께 발송되었습니다.' : ''));
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
    $('#admin-round-panel').hidden = tab !== 'round';
    $('#admin-notifications').hidden = tab !== 'notifications';
    $('#admin-master').hidden = tab !== 'master';
    renderAdminView();
  }

  function renderAdminView() {
    if (state.adminTab === 'dashboard') renderDashboard();
    else if (state.adminTab === 'round') renderRoundPanel();
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

  /**
   * 재고보정 확정 칸.
   *
   * 요청 원문: "재고보정에 O표시가 있는경우 결과자료에 별도로 취합 되어야 합니다"
   * 총괄표 하단 「보정요청 리스트」로 가는 값이라, 담당자가 O/X 를 확정하고
   * 귀책(HCE/협력업체)까지 골라야 결과 추출이 완성된다.
   */
  function correctionCell(l, i, audit) {
    if (!Logic.isCorrectionCandidate(l)) return '<span class="muted">-</span>';

    var locked = audit.status === Logic.AUDIT_STATUS.APPROVED;
    var cur = String(l.correction || '');
    var amt = Logic.correctionAmount(l);

    if (locked) {
      return cur.toUpperCase() === 'O'
        ? '<span class="badge badge-mismatch">O</span><div class="muted">' +
          fmt(amt) + '원 · ' + esc(l.fault || '-') + ' · ' + esc(l.action || '') + '</div>'
        : '<span class="muted">' + (cur ? esc(cur) : '판단 없음') + '</span>';
    }

    var cls = cur === '' ? 'is-pending' : 'is-set';
    var html = '<div class="corr-cell">' +
      '<select class="sel-corr ' + cls + '" data-idx="' + i + '">' +
      '<option value=""' + (cur === '' ? ' selected' : '') + '>판단 대기</option>' +
      '<option value="O"' + (cur === 'O' ? ' selected' : '') + '>O (보정)</option>' +
      '<option value="X"' + (cur === 'X' ? ' selected' : '') + '>X (보정 안 함)</option>' +
      '</select>';

    if (cur.toUpperCase() === 'O') {
      html += '<select class="sel-fault" data-idx="' + i + '">' +
        '<option value=""' + (!l.fault ? ' selected' : '') + '>귀책 선택</option>' +
        '<option value="HCE"' + (l.fault === 'HCE' ? ' selected' : '') + '>HCE</option>' +
        '<option value="협력업체"' + (l.fault === '협력업체' ? ' selected' : '') + '>협력업체</option>' +
        '</select>' +
        '<span class="muted">' + fmt(amt) + '원 · ' + esc(l.action || Logic.ACTION_CORRECTION) + '</span>';
    }
    return html + '</div>';
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
      '<th>아이템</th><th class="num">전산재고</th><th class="num">실물재고</th><th class="num">차이</th>' +
      '<th class="num">금액차이(원)</th><th>판정</th><th>재고보정</th><th>소명/사유</th><th>삭제 요청</th></tr></thead><tbody>' +
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
          '<td>' + correctionCell(l, i, audit) + '</td>' +
          '<td class="reason-text">' + esc(l.reason || '-') + '</td>' +
          '<td>' + delCell + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    html += '<div class="detail-foot">';
    html += att
      ? '<div class="file-chip">📎 첨부 확인서: ' + esc(att.fileName) + ' <span class="muted">(' + fmt(Math.round(att.size / 1024)) + ' KB)</span></div>' +
        (att.preview ? '<img class="file-preview" src="' + esc(att.preview) + '" alt="확인서 미리보기">' : '')
      : '<p class="muted">첨부 확인서 없음</p>';
    var pendingDeletes = lines.some(function (l) { return l.deleteRequested && l.deleteStatus === '대기'; });
    if (audit.status !== Logic.AUDIT_STATUS.APPROVED) {
      html += '<div class="btn-group">' +
        '<button type="button" class="btn btn-primary" id="btn-approve-audit"' + (pendingDeletes ? ' disabled title="삭제 요청을 먼저 승인/반려해 주세요"' : '') + '>실사 승인</button>' +
        (pendingDeletes ? '<span class="muted">삭제 요청 처리 후 승인할 수 있습니다.</span>' : '') + '</div>';
    }
    html += '</div>';
    panel.innerHTML = html;

    $all('#audit-detail .sel-corr').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var l = lines[Number(sel.getAttribute('data-idx'))];
        Store.setCorrection(audit.id, l.itemId, {
          correction: sel.value,
          // O 로 바꾸면 조치사항은 총괄표에 쓰이는 코드로 기본값을 채운다
          action: sel.value.toUpperCase() === 'O' ? (l.action || Logic.ACTION_CORRECTION) : ''
        });
        renderDashboard();
      });
    });
    $all('#audit-detail .sel-fault').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var l = lines[Number(sel.getAttribute('data-idx'))];
        Store.setCorrection(audit.id, l.itemId, { fault: sel.value });
        renderDashboard();
      });
    });

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

  // ---------------------------------------------------------------
  // 회차 관리 (2026-08-24 보완)
  // ---------------------------------------------------------------

  function renderRoundPanel() {
    var db = Store.load();
    var plan = Store.roundPlan();

    $('#round-book-base').value = plan.bookBase || '';
    $('#round-due-date').value = plan.dueDate || '';
    $('#round-book-updated').textContent = plan.bookUpdatedAt
      ? '마지막 전산재고 갱신: ' + String(plan.bookUpdatedAt).replace('T', ' ')
      : '아직 전산재고를 올린 적이 없습니다.';
    $('#round-request-result').textContent = plan.requestedAt
      ? '마지막 등록요청 발송: ' + String(plan.requestedAt).replace('T', ' ')
      : '아직 등록요청을 보낸 적이 없습니다.';

    // 업체별 마감 대비 상태
    $('#round-vendor-rows').innerHTML = db.vendors.map(function (v) {
      var status = Logic.vendorSubmissionStatus(db.audits, db.auditLines, v.bizNo, db.round);
      var audit = db.audits.find(function (a) {
        return Logic.normalizeBizNo(a.bizNo) === Logic.normalizeBizNo(v.bizNo) && a.round === db.round;
      });
      var o = Logic.computeOverdue(plan.dueDate, new Date(), status !== '미제출',
        audit && audit.submittedAt);
      var label, cls;
      if (o.state === '지각')          { label = o.days + '일 지각'; cls = 'badge-late'; }
      else if (o.state === '지각제출') { label = o.days + '일 늦게 제출'; cls = 'badge-late-soft'; }
      else if (o.state === '임박')     { label = o.days === 0 ? '오늘 마감' : o.days + '일 남음'; cls = 'badge-draft'; }
      else if (o.state === '여유')     { label = o.days + '일 남음'; cls = 'badge-draft'; }
      else if (o.state === '기한내제출') { label = '기한 내 제출'; cls = 'badge-approved'; }
      else                              { label = '마감 미설정'; cls = 'badge-draft'; }

      return '<tr><td>' + esc(v.name) + '</td><td>' + esc(v.manager || '-') + '</td>' +
        '<td>' + esc(v.phone || '-') + '</td>' +
        '<td>' + statusBadge(status) + '</td>' +
        '<td><span class="badge ' + cls + '">' + esc(label) + '</span></td></tr>';
    }).join('');

    renderPreflight(db);
  }

  /** 결과 추출 전 점검 — 확인서 누락 / 재고보정 판단 대기 / 불일치 */
  function renderPreflight(db) {
    var pf = Logic.buildPreflight(db.vendors, db.audits, db.auditLines, db.attachments, db.round);

    function line(label, arr, render) {
      var ok = arr.length === 0;
      return '<p class="pf-line"><span class="' + (ok ? 'ok' : 'bad') + '">' +
        (ok ? '이상 없음' : arr.length + '건') + '</span> · ' + esc(label) +
        (ok ? '' : ' — ' + render(arr)) + '</p>';
    }

    var html = '';
    html += line('미제출 업체', pf.notSubmitted, function (a) {
      return esc(a.join(', '));
    });
    html += line('결과확인서 누락', pf.missingCert, function (a) {
      return esc(a.join(', '));
    });
    html += line('재고보정 판단 대기', pf.pendingCorrection, function (a) {
      return esc(a.map(function (x) { return x.vendorName + ' ' + x.itemName; }).join(', '));
    });
    html += '<p class="pf-line"><span class="' + (pf.mismatch.length ? 'bad' : 'ok') + '">' +
      (pf.mismatch.length ? pf.mismatch.length + '건' : '이상 없음') + '</span> · 불일치' +
      (pf.mismatch.length ? ' — ' + esc(pf.mismatch.map(function (x) {
        return x.vendorName + ' ' + x.itemName + '(' + (x.diff > 0 ? '+' : '') + x.diff + ')';
      }).join(', ')) : '') + '</p>';

    html += pf.ready
      ? '<div class="pf-ready">결과 추출 준비가 되었습니다. 상단 [엑셀 보고서 다운로드]로 총괄표를 받으세요.</div>'
      : '<div class="pf-notready">위 항목을 처리한 뒤 결과를 추출하세요. ' +
        '불일치는 남아 있어도 됩니다 — 재고보정 O/X 판단만 끝나면 총괄표 하단 보정요청 리스트로 취합됩니다.</div>';

    $('#preflight-body').innerHTML = html;
  }

  /** 전산재고 엑셀 업로드 — 제출한 업체는 건드리지 않는다 */
  function handleBookStockUpload(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var db = Store.load();

    // 이미 제출한 업체의 장부수량을 바꾸면 그 업체가 낸 실사 결과의 근거가 사라진다
    var locked = db.vendors.filter(function (v) {
      return Logic.vendorSubmissionStatus(db.audits, db.auditLines, v.bizNo, db.round) !== '미제출';
    }).map(function (v) { return v.bizNo; });

    Report.readBookStock(file, function (err, rows) {
      e.target.value = '';
      if (err) { $('#round-book-result').textContent = '읽기 실패: ' + err.message; return; }
      if (!rows.length) {
        $('#round-book-result').textContent =
          '읽을 행이 없습니다. 품번(또는 아이템ID)과 장부수량 열이 있는지 확인해 주세요.';
        return;
      }

      var r = Store.updateBookStock(rows, locked);
      Store.setRoundPlan({
        bookBase: $('#round-book-base').value || Store.roundPlan().bookBase,
        bookUpdatedAt: new Date().toISOString().slice(0, 19)
      });
      $('#round-book-result').textContent =
        '갱신 ' + r.updated + '건' +
        (r.skippedLocked ? ' · 제출 완료 업체라 건너뜀 ' + r.skippedLocked + '건' : '') +
        (r.notFound.length ? ' · 찾지 못한 품번 ' + r.notFound.length + '건(' +
          r.notFound.slice(0, 5).join(', ') + (r.notFound.length > 5 ? ' …' : '') + ')' : '');
      renderRoundPanel();
    });
  }

  /** 전 업체에 등록요청 발송 */
  function sendRegistrationRequest() {
    var db = Store.load();
    var due = $('#round-due-date').value;
    if (!due) { alert('먼저 등록 마감일을 정해 주세요.'); return; }

    Store.setRoundPlan({ dueDate: due, requestedAt: new Date().toISOString().slice(0, 19) });

    var targets = db.vendors.filter(function (v) {
      return Logic.vendorSubmissionStatus(db.audits, db.auditLines, v.bizNo, db.round) === '미제출';
    });
    if (!targets.length) {
      alert('미제출 업체가 없습니다. 전 업체가 이미 등록을 마쳤습니다.');
      renderRoundPanel();
      return;
    }
    if (!confirm('미제출 업체 ' + targets.length + '곳에 등록요청을 보냅니다.\n마감일: ' + due)) return;

    targets.forEach(function (v) {
      Store.notify(v.email,
        '[실사 등록 요청] ' + db.round + ' 재고 실사 결과를 ' + due + '까지 등록해 주세요. ' +
        '기한을 넘기면 접속 화면 상단에 지각일수가 표시됩니다.');
    });
    $('#round-request-result').textContent =
      '방금 ' + targets.length + '곳에 등록요청을 보냈습니다. (마감 ' + due + ')';
    renderRoundPanel();
  }

  /**
   * 전 업체 등록 완료 시 담당자에게 통지.
   *
   * 요청 원문: "관리자는 업체들이 모두 등록 완료되었음을 사이트가 메일 혹은 문자를 보내
   * 공유받고 알 수 있어야 하고"
   * 한 회차에 한 번만 보낸다 — 이후 승인·수정 때마다 다시 나가면 알림이 무의미해진다.
   */
  function notifyIfAllSubmitted(db) {
    var plan = Store.roundPlan();
    if (plan.completedNotifiedAt) return false;
    if (!Logic.allSubmitted(db.vendors, db.audits, db.auditLines, db.round)) return false;

    var pf = Logic.buildPreflight(db.vendors, db.audits, db.auditLines, db.attachments, db.round);
    Store.notify(HD_EMAIL,
      '[전 업체 등록 완료] ' + db.round + ' 재고 실사에 대해 ' + db.vendors.length +
      '개 업체가 모두 등록을 마쳤습니다. ' +
      '확인서 누락 ' + pf.missingCert.length + '건 · 불일치 ' + pf.mismatch.length + '건 · ' +
      '재고보정 판단 대기 ' + pf.pendingCorrection.length + '건. 결과 추출 전 점검을 확인해 주세요.');
    Store.setRoundPlan({ completedNotifiedAt: new Date().toISOString().slice(0, 19) });
    return true;
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
      var msg = '임포트 완료 — 업체 ' + counts.vendors + '건, 아이템 ' + counts.items + '건을 반영했습니다.';
      var a = counts.vendorAnalysis;
      if (a) {
        msg += '\n\n업체 시트 상세: 신규 ' + a.newCount + '건 / 덮어씀 ' + a.overwriteCount +
          '건 / 파일 내 중복 ' + a.duplicateInFileCount + '건';
        if (a.defaultPasswordCount > 0) {
          msg += '\n비밀번호 미입력 ' + a.defaultPasswordCount + '건에 기본값(' +
            Logic.DEFAULT_VENDOR_PASSWORD + ')을 적용했습니다.';
        }
      }
      alert(msg);
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
    // 데모 모드는 여기서 시드를 만든다. 서버 모드는 **로그인 뒤에** 받아 오므로
    // 지금 부르면 "먼저 로그인해야 합니다" 로 죽는다.
    if (!SERVER) Store.load();

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

    // 회차 관리 (2026-08-24 보완)
    $('#round-book-file').addEventListener('change', handleBookStockUpload);
    $('#btn-save-due').addEventListener('click', function () {
      var due = $('#round-due-date').value;
      if (!due) { alert('마감일을 골라 주세요.'); return; }
      Store.setRoundPlan({ dueDate: due, bookBase: $('#round-book-base').value || undefined });
      alert('등록 마감일을 ' + due + '로 저장했습니다.');
      renderRoundPanel();
    });
    $('#btn-send-request').addEventListener('click', sendRegistrationRequest);
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

  /* ═══════════════════════════ 연결 모드 ═══════════════════════════

     지금 어디에 저장되는지 화면 위 띠로 늘 알린다.
     모르고 쓰면 나중에 "입력한 게 사라졌다"가 된다.
     ─────────────────────────────────────────────────────────────── */

  function banner(kind, detail) {
    var el = document.getElementById('hd-conn-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hd-conn-banner';
      el.setAttribute('role', 'status');
      document.body.insertBefore(el, document.body.firstChild);
    }
    var map = {
      server: ['서버에 연결됨 — 업체는 자기 자료만 보고, 담당자는 전부 봅니다.', '#e3f4ec', '#0a6045'],
      demo:   ['이 브라우저에만 저장됩니다 — 다른 업체·담당자에게는 보이지 않습니다.', '#fdf4e3', '#7a4f00']
    };
    var m = map[kind] || map.demo;
    el.style.cssText = 'padding:8px 16px;font-size:13px;line-height:1.5;text-align:center;'
      + 'background:' + m[1] + ';color:' + m[2] + ';border-bottom:1px solid rgba(0,0,0,.08)';
    el.textContent = m[0] + (detail ? ' ' + detail : '');
  }

  function boot() {
    var SS = window.SupabaseStore;
    if (SS && SS.available()) {
      SERVER = true;
      Store = SS.api;
      Store.ROUND = window.Store.ROUND;
      SS.onNotify(function (msg) { banner('server', '(' + String(msg).split('\n')[0] + ')'); });
      banner('server', '로그인하면 자료를 받아 옵니다.');
      // 서버 모드에는 데모 계정이 없다 — 보여 주면 그 값으로 로그인하려다 막힌다.
      var card = document.getElementById('demo-accounts-card');
      if (card) card.hidden = true;
      var row = document.getElementById('login-hd-email-row');
      if (row) row.hidden = false;
    } else {
      SERVER = false;
      Store = window.Store;
      banner('demo');
    }
    init();
  }

  document.addEventListener('DOMContentLoaded', boot);
})(window);
