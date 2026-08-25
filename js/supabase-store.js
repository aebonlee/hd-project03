/**
 * supabase-store.js — 업체가 각자 자기 것만 보게 만드는 연결층
 *
 * 이 포털의 목적은 **여러 업체가 각자 접속해 자기 실사 결과를 올리고,
 * 담당자가 전부 모아 보고서를 뽑는 것**이다.
 * 자료가 브라우저에만 있으면 업체 화면과 담당자 화면이 서로 다른 것을 보게 되어
 * 목적 자체가 성립하지 않는다.
 *
 * ── 왜 「문서 통째로 공유」를 쓰지 않았나 ────────────────────────────────
 *   다른 프로젝트(05·08)는 자료 한 뭉치를 서버에 두고 팀원이 같은 것을 본다.
 *   여기서는 **쓸 수 없다.** 그 방식은 접속한 사람이 문서 전체를 받으므로
 *   대한테크가 한빛물류의 실사 결과를 그대로 받게 된다.
 *   그래서 행 단위로 담고, 격리는 **화면이 아니라 DB(RLS)** 가 한다.
 *   화면에서만 거르면 주소만 바꿔도 남의 자료가 보인다.
 *
 * ── 화면 코드는 그대로 둔다 ─────────────────────────────────────────────
 *   js/store.js 와 **같은 함수 이름·같은 반환값**을 내놓는다.
 *   app.js 는 `Store` 하나만 보고 쓰므로 저장 위치가 바뀐 것을 모른다.
 *   화면 계산이 전부 동기 함수라, 읽기는 로그인 직후 한 번에 받아 메모리에 올린다.
 *
 * ── 쓰기 ────────────────────────────────────────────────────────────────
 *   app.js 는 메모리 문서를 고친 뒤 `save()` 를 부른다.
 *   여기서는 **바뀐 행만 골라** 보낸다. 전부 보내면 글자 하나 고칠 때마다
 *   표 전체를 다시 쓴다.
 */
(function (root) {
  'use strict';

  var CFG = root.APP_CONFIG || {};
  var client = null;
  var mem = null;            // 화면이 쓰는 문서 (js/store.js 와 같은 모양)
  var snap = {};             // '표:키' → 마지막으로 보낸 JSON
  var me = { role: null, bizNo: null, name: null };
  var notifyFn = null;
  var lastError = null;

  function available() {
    return !!(CFG.USE_SUPABASE && CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY
      && root.supabase && typeof root.supabase.createClient === 'function');
  }

  function db() {
    if (client) return client;
    client = root.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    return client;
  }

  function onNotify(fn) { notifyFn = fn; }
  function fail(msg) {
    lastError = msg;
    if (notifyFn) { try { notifyFn(msg); return; } catch (e) {} }
    if (root.alert) root.alert(msg);
  }

  /* ───────────────────────────── 로그인 ───────────────────────────── */

  /**
   * 업체는 이메일이 아니라 **사업자번호**로 로그인한다.
   * Supabase Auth 는 이메일만 받으므로 `사업자번호@도메인` 꼴로 바꿔 넘긴다.
   * 계정을 만들 때도 **같은 규칙**으로 만들어야 맞물린다.
   */
  function bizEmail(bizNo) {
    var d = CFG.AUTH_EMAIL_DOMAIN || 'vendor.example.com';
    return String(bizNo).replace(/[^0-9]/g, '') + '@' + d;
  }

  function signInVendor(bizNo, password) {
    return db().auth.signInWithPassword({ email: bizEmail(bizNo), password: password })
      .then(function (r) { if (r.error) throw r.error; return r.data; });
  }
  function signInManager(email, password) {
    return db().auth.signInWithPassword({ email: email, password: password })
      .then(function (r) { if (r.error) throw r.error; return r.data; });
  }
  function signOut() { me = { role: null, bizNo: null, name: null }; return db().auth.signOut(); }
  function session() { return db().auth.getSession().then(function (r) { return r.data && r.data.session; }); }
  function whoami() { return me; }

  /**
   * 지금 접속한 사람이 담당자인지 업체인지 **DB 에게 묻는다.**
   * 화면이 기억한 값을 믿으면, 로그인 화면을 우회한 사람이 관리자 화면을 열 수 있다.
   */
  function resolveRole() {
    return Promise.all([
      db().rpc('is_hd_manager'),
      db().rpc('current_biz_no')
    ]).then(function (r) {
      var isMgr = !r[0].error && r[0].data === true;
      var biz = !r[1].error ? r[1].data : null;
      me = { role: isMgr ? 'hd' : (biz ? 'vendor' : null), bizNo: biz || null, name: null };
      return me;
    });
  }

  /* ─────────────────────────── 열 이름 옮기기 ─────────────────────────── */
  // 화면은 camelCase, 표는 snake_case 다. 변환은 여기서만 한다.

  function toVendor(r) {
    return { bizNo: r.biz_no, vendorCode: r.vendor_code || '', name: r.name,
             manager: r.manager_name || '', phone: r.phone || '', email: r.email || '' };
  }
  function fromVendor(v) {
    return { biz_no: v.bizNo, vendor_code: v.vendorCode || null, name: v.name,
             manager_name: v.manager || null, phone: v.phone || null, email: v.email || null };
  }

  function toItem(r) {
    return { id: r.id, partNo: r.part_no || '', bizNo: r.biz_no, name: r.name,
             spec: r.spec || '', qty: Number(r.qty), unitPrice: Number(r.unit_price),
             amount: Number(r.amount), rentedAt: r.rented_at, status: r.status };
  }
  function fromItem(i) {
    // ⚠ amount 는 표가 `qty * unit_price` 로 계산하는 열이다.
    //    보내면 "generated column 에는 쓸 수 없다"며 저장이 통째로 실패한다.
    return { id: i.id, biz_no: i.bizNo, part_no: i.partNo || null, name: i.name,
             spec: i.spec || null, qty: Number(i.qty) || 0,
             unit_price: Number(i.unitPrice) || 0,
             rented_at: i.rentedAt || null, status: i.status || '대여중' };
  }

  function toAudit(r) {
    return { id: r.id, bizNo: r.biz_no, round: r.round, status: r.status,
             submittedAt: r.submitted_at ? String(r.submitted_at).slice(0, 19).replace('T', ' ') : null,
             approvedAt: r.approved_at ? String(r.approved_at).slice(0, 19).replace('T', ' ') : null };
  }
  function fromAudit(a) {
    var row = { biz_no: a.bizNo, round: a.round, status: a.status,
                submitted_at: a.submittedAt || null, approved_at: a.approvedAt || null };
    // ⚠ 새 실사는 id 가 아직 없다. `id: null` 을 **보내면 안 된다** —
    //    표의 기본값(gen_random_uuid())을 덮어써서 "null value in column id" 로 거부된다.
    //    키를 아예 빼야 기본값이 걸린다.
    if (a.id) row.id = a.id;
    return row;
  }

  function toLine(r, itemById) {
    var it = itemById[r.item_id] || {};
    return {
      auditId: r.audit_id, itemId: r.item_id,
      partNo: r.part_no || it.partNo || '',
      // 아이템명·규격·업체번호는 표에 없다 — rental_item 에서 붙인다.
      // 같은 값을 두 표에 넣으면 한쪽만 고쳐져 갈라진다.
      itemName: it.name || '', spec: it.spec || '', bizNo: it.bizNo || '',
      bookQty: Number(r.book_qty), unitPrice: Number(r.unit_price),
      bookAmount: Number(r.book_qty) * Number(r.unit_price),
      actualQty: r.actual_qty === null ? null : Number(r.actual_qty),
      diff: r.diff === null ? null : Number(r.diff),
      amountDiff: r.amount_diff === null ? null : Number(r.amount_diff),
      reason: r.reason || '',
      deleteRequested: !!r.delete_requested,
      deleteStatus: r.delete_status || null,
      correction: r.correction || '', fault: r.fault || '',
      action: r.action_code || '',
      correctionAmount: Number(r.correction_amount) || 0
    };
  }
  function fromLine(l) {
    // ⚠ diff · amount_diff 는 계산되는 열이라 보내지 않는다.
    //   correction_amount 도 트리거가 채우므로 보내지 않는다 — 보내면 화면이
    //   기억한 옛값이 트리거 계산을 덮을 수 있다.
    return {
      audit_id: l.auditId, item_id: l.itemId, part_no: l.partNo || null,
      book_qty: Number(l.bookQty) || 0, unit_price: Number(l.unitPrice) || 0,
      actual_qty: (l.actualQty === null || l.actualQty === undefined) ? null : Number(l.actualQty),
      reason: l.reason || null,
      delete_requested: !!l.deleteRequested,
      delete_status: l.deleteStatus || null,
      correction: l.correction || null,
      fault: l.fault || null,
      action_code: l.action || null
    };
  }

  function toAttach(r) {
    return { auditId: r.audit_id, fileName: r.file_name, storagePath: r.storage_path,
             size: Number(r.size_bytes) || 0, type: r.mime_type || '', preview: null };
  }
  function toNotif(r) {
    return { id: 'NT-' + r.id, to: r.target, channel: r.channel, message: r.message,
             sentAt: String(r.sent_at).slice(0, 19).replace('T', ' ') };
  }
  function toPlan(r) {
    return { round: r.round, bookBase: r.book_base || '',
             bookUpdatedAt: r.book_updated_at || null, dueDate: r.due_date || '',
             requestedAt: r.requested_at || null, completedNotifiedAt: r.completed_notified_at || null };
  }
  function fromPlan(p, round) {
    return { round: round, book_base: p.bookBase || null,
             book_updated_at: p.bookUpdatedAt || null, due_date: p.dueDate || null,
             requested_at: p.requestedAt || null,
             completed_notified_at: p.completedNotifiedAt || null };
  }

  /* ───────────────────────────── 읽기 ───────────────────────────── */

  var ROUND = null;

  /**
   * 로그인 뒤 한 번 부른다. RLS 가 이미 걸러 주므로 **여기서 따로 거르지 않는다.**
   * 업체 계정으로 받으면 자기 행만 돌아온다.
   */
  function boot(round) {
    ROUND = round;
    return resolveRole().then(function () {
      return Promise.all([
        db().from('vendor').select('*').order('biz_no'),
        db().from('rental_item').select('*').order('id'),
        db().from('audit').select('*').eq('round', round),
        db().from('audit_line').select('*'),
        db().from('attachment').select('*'),
        db().from('round_plan').select('*').eq('round', round).maybeSingle(),
        // 알림은 담당자만 볼 수 있다(정책). 업체로 접속하면 빈 배열이 온다 — 정상이다.
        db().from('notification').select('*').order('sent_at', { ascending: true }).limit(300)
      ]);
    }).then(function (res) {
      var bad = res.filter(function (r) { return r.error; });
      if (bad.length) throw bad[0].error;

      var items = (res[1].data || []).map(toItem);
      var itemById = {};
      items.forEach(function (i) { itemById[i.id] = i; });

      mem = {
        round: round,
        roundPlan: res[5].data ? toPlan(res[5].data)
                               : { round: round, bookBase: '', bookUpdatedAt: null,
                                   dueDate: '', requestedAt: null, completedNotifiedAt: null },
        vendors: (res[0].data || []).map(toVendor),
        items: items,
        audits: (res[2].data || []).map(toAudit),
        auditLines: (res[3].data || []).map(function (r) { return toLine(r, itemById); }),
        attachments: (res[4].data || []).map(toAttach),
        notifications: (res[6].data || []).map(toNotif),
        seq: (res[6].data || []).length
      };
      takeSnapshot();
      return mem;
    });
  }

  function key(kind, row) {
    if (kind === 'vendor') return 'vendor:' + row.bizNo;
    if (kind === 'item')   return 'item:' + row.id;
    if (kind === 'audit')  return 'audit:' + row.id;
    if (kind === 'line')   return 'line:' + row.auditId + '|' + row.itemId;
    return kind + ':?';
  }
  function takeSnapshot() {
    snap = {};
    if (!mem) return;
    mem.vendors.forEach(function (r) { snap[key('vendor', r)] = JSON.stringify(fromVendor(r)); });
    mem.items.forEach(function (r) { snap[key('item', r)] = JSON.stringify(fromItem(r)); });
    mem.audits.forEach(function (r) { snap[key('audit', r)] = JSON.stringify(fromAudit(r)); });
    mem.auditLines.forEach(function (r) { snap[key('line', r)] = JSON.stringify(fromLine(r)); });
    snap['plan'] = JSON.stringify(fromPlan(mem.roundPlan, mem.round));
  }

  /* ───────────────────────────── 쓰기 ───────────────────────────── */

  function changed(kind, rows, mapper) {
    return rows.filter(function (r) {
      return JSON.stringify(mapper(r)) !== snap[key(kind, r)];
    });
  }

  /** 바뀐 행만 보낸다. 순서: 실사 → 상세 (상세가 실사를 참조하므로) */
  function push() {
    if (!mem) return Promise.resolve(0);
    var jobs = [];
    var n = 0;

    var vs = changed('vendor', mem.vendors, fromVendor);
    if (vs.length) { n += vs.length;
      jobs.push(db().from('vendor').upsert(vs.map(fromVendor), { onConflict: 'biz_no' })); }

    var its = changed('item', mem.items, fromItem);
    if (its.length) { n += its.length;
      jobs.push(db().from('rental_item').upsert(its.map(fromItem), { onConflict: 'id' })); }

    var planNow = JSON.stringify(fromPlan(mem.roundPlan, mem.round));
    if (planNow !== snap['plan']) { n += 1;
      jobs.push(db().from('round_plan').upsert(fromPlan(mem.roundPlan, mem.round), { onConflict: 'round' })); }

    var first = jobs.length ? Promise.all(jobs) : Promise.resolve([]);

    return first.then(function (rr) {
      var e = rr.filter(function (x) { return x && x.error; });
      if (e.length) throw e[0].error;
      var au = changed('audit', mem.audits, fromAudit);
      if (!au.length) return [];
      n += au.length;
      // 새로 만든 실사는 서버가 정한 id 를 **돌려받아 메모리에 붙여야** 한다.
      // 안 그러면 이어서 보내는 실사 상세가 audit_id 를 null 로 들고 간다.
      return db().from('audit').upsert(au.map(fromAudit), { onConflict: 'biz_no,round' })
        .select('id, biz_no, round')
        .then(function (r) {
          if (r.error) throw r.error;
          (r.data || []).forEach(function (row) {
            var hit = mem.audits.filter(function (x) {
              return x.bizNo === row.biz_no && x.round === row.round;
            })[0];
            if (hit && !hit.id) {
              // 상세가 이미 이 실사를 가리키고 있으면 함께 채워 준다
              mem.auditLines.forEach(function (l) { if (!l.auditId) l.auditId = row.id; });
              hit.id = row.id;
            }
          });
          return r;
        });
    }).then(function () {
      var ln = changed('line', mem.auditLines, fromLine);
      if (!ln.length) return null;
      n += ln.length;

      // ⚠ 전부 upsert 로 보내면 담당자가 막힌다.
      //    정책상 audit_line 에 **INSERT 할 수 있는 것은 업체뿐**이고(작성중일 때),
      //    담당자는 UPDATE 만 할 수 있다(재고보정 확정·삭제요청 처리).
      //    upsert 는 INSERT ... ON CONFLICT 라 담당자에게는 통째로 거부된다
      //    ("new row violates row-level security policy").
      //    그래서 **서버에서 받아 온 행은 UPDATE, 처음 만드는 행만 INSERT** 로 나눈다.
      var fresh = ln.filter(function (l) { return snap[key('line', l)] === undefined; });
      var known = ln.filter(function (l) { return snap[key('line', l)] !== undefined; });

      var jobs2 = [];
      if (fresh.length) {
        jobs2.push(db().from('audit_line')
          .upsert(fresh.map(fromLine), { onConflict: 'audit_id,item_id' }));
      }
      known.forEach(function (l) {
        var row = fromLine(l);
        delete row.audit_id; delete row.item_id;   // 키는 바꾸지 않는다
        jobs2.push(db().from('audit_line').update(row)
          .eq('audit_id', l.auditId).eq('item_id', l.itemId));
      });
      return Promise.all(jobs2).then(function (rr) {
        var e = rr.filter(function (x) { return x && x.error; });
        if (e.length) throw e[0].error;
        return rr;
      });
    }).then(function () {
      takeSnapshot();
      return n;
    }).catch(function (err) {
      var msg = (err && (err.message || err.hint)) || String(err);
      fail('서버에 저장하지 못했습니다 — ' + msg +
           '\n화면의 값은 아직 서버에 반영되지 않았습니다.');
      throw err;
    });
  }

  /* ─────────────────── js/store.js 와 같은 모양의 API ─────────────────── */

  var Store = {
    ROUND: null,

    load: function () {
      if (!mem) throw new Error('먼저 로그인해야 합니다 (SupabaseStore.boot).');
      return mem;
    },

    save: function () { push().catch(function () { /* 알림은 push 가 한다 */ }); },

    reset: function () {
      // 운영 자료를 화면 버튼으로 지우게 두지 않는다.
      throw new Error('서버 모드에서는 데모 초기화를 쓸 수 없습니다.');
    },

    roundPlan: function () { return this.load().roundPlan; },

    setRoundPlan: function (patch) {
      var plan = this.roundPlan();
      Object.keys(patch || {}).forEach(function (k) { plan[k] = patch[k]; });
      this.save();
      return plan;
    },

    updateBookStock: function (rows, lockedBizNos) {
      var db_ = this.load();
      var locked = {};
      (lockedBizNos || []).forEach(function (b) { locked[b] = true; });
      var updated = 0, skippedLocked = 0, notFound = 0;

      (rows || []).forEach(function (r) {
        var item = db_.items.filter(function (i) {
          return (r.partNo && i.partNo === r.partNo) || i.id === r.itemId;
        })[0];
        if (!item) { notFound++; return; }
        if (locked[item.bizNo]) { skippedLocked++; return; }
        if (r.qty !== undefined && r.qty !== null && isFinite(Number(r.qty))) item.qty = Number(r.qty);
        if (r.unitPrice !== undefined && r.unitPrice !== null && isFinite(Number(r.unitPrice))) {
          item.unitPrice = Number(r.unitPrice);
        }
        item.amount = item.qty * item.unitPrice;
        updated++;
      });

      this.save();
      return { updated: updated, skippedLocked: skippedLocked, notFound: notFound };
    },

    setCorrection: function (auditId, itemId, patch) {
      var d = this.load();
      var line = d.auditLines.filter(function (l) {
        return l.auditId === auditId && l.itemId === itemId;
      })[0];
      if (!line) return null;
      if (patch.correction !== undefined) line.correction = patch.correction;
      if (patch.fault !== undefined) line.fault = patch.fault;
      if (patch.action !== undefined) line.action = patch.action;
      // 화면에는 바로 보여 주되, 서버 값의 정본은 트리거다.
      line.correctionAmount = String(line.correction || '').toUpperCase() === 'O'
        ? (Number(line.diff) || 0) * (Number(line.unitPrice) || 0)
        : 0;
      this.save();
      return line;
    },

    /**
     * 알림 기록. 정책상 **쓰기는 서비스 롤(Edge Function)** 몫이라
     * 브라우저에서는 남기지 못한다. 화면에는 즉시 보여 주되,
     * 서버에 안 남았다는 사실을 감추지 않는다.
     */
    notify: function (to, message) {
      var d = this.load();
      d.seq = (d.seq || 0) + 1;
      d.notifications.push({
        id: 'NT-' + String(d.seq).padStart(3, '0'),
        to: to, channel: '이메일', message: message,
        sentAt: new Date().toISOString().slice(0, 19),
        serverSaved: false
      });
      db().from('notification')
        .insert({ target: to, channel: '이메일', message: message })
        .then(function (r) {
          if (!r.error) d.notifications[d.notifications.length - 1].serverSaved = true;
        });
    }
  };

  root.SupabaseStore = {
    available: available, client: db,
    signInVendor: signInVendor, signInManager: signInManager,
    signOut: signOut, session: session, resolveRole: resolveRole, whoami: whoami,
    bizEmail: bizEmail,
    boot: boot, push: push, api: Store, onNotify: onNotify,
    lastError: function () { return lastError; },
    // 검사용
    _map: { toVendor: toVendor, fromVendor: fromVendor, toItem: toItem, fromItem: fromItem,
            toAudit: toAudit, fromAudit: fromAudit, toLine: toLine, fromLine: fromLine,
            toPlan: toPlan, fromPlan: fromPlan }
  };
})(typeof self !== 'undefined' ? self : this);
