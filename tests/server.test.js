/**
 * 서버 모드 통합 테스트 — 실행: scripts/sqltest/run-server-test.sh
 *
 * 이 포털에서 가장 중요한 것은 **업체 간 격리**다.
 * 대한테크가 한빛물류의 실사 결과를 보면 안 된다.
 * 그리고 그 격리는 화면이 아니라 **DB(RLS)** 가 해야 한다 —
 * 화면에서만 거르면 주소만 바꿔도 남의 자료가 보인다.
 *
 * 그래서 여기서는 실제 PostgreSQL 에 진짜 schema.sql 을 올리고,
 * **RLS 를 켠 채로** 업체 계정을 가장해 어댑터를 그대로 태운다.
 * (superuser 로 붙으면 RLS 가 우회되어 아무것도 증명되지 않는다)
 */
"use strict";
const assert = require("assert");
const path = require("path");
const vm = require("vm");
const fs = require("fs");
const { makeClient, query, setAuth } = require("./fake-supabase.js");

const root = path.join(__dirname, "..");
const ROUND = "2026-08";

const UID = {
  A:   "11111111-1111-1111-1111-111111111111",   // 대한테크
  B:   "22222222-2222-2222-2222-222222222222",   // 한빛물류
  MGR: "99999999-9999-9999-9999-999999999999"    // HD 담당자
};
const BIZ = { A: "1234567890", B: "2345678901" };

/* ── 준비: 계정·업체·아이템을 superuser 로 심는다 ─────────────────────── */
function seed() {
  setAuth(null);
  query(`insert into auth.users (id, email) values
      ('${UID.A}','${BIZ.A}@vendor.example.com'),
      ('${UID.B}','${BIZ.B}@vendor.example.com'),
      ('${UID.MGR}','mgr@hd.example.com')
    on conflict (id) do nothing`);
  query(`insert into vendor (biz_no, name, vendor_code, manager_name, email, auth_user_id) values
      ('${BIZ.A}','대한테크','10000949','김민준','a@x.com','${UID.A}'),
      ('${BIZ.B}','한빛물류','10001391','이서연','b@x.com','${UID.B}')
    on conflict (biz_no) do update set auth_user_id = excluded.auth_user_id`);
  query(`insert into hd_manager (auth_user_id, name, email)
    values ('${UID.MGR}','담당자','mgr@hd.example.com') on conflict do nothing`);
  query(`insert into rental_item (id, biz_no, part_no, name, spec, qty, unit_price, rented_at) values
      ('IT-A-001','${BIZ.A}','P-A-001','유압호스','1/2인치',10,50000,'2026-01-10'),
      ('IT-A-002','${BIZ.A}','P-A-002','커플러','20A',4,120000,'2026-02-01'),
      ('IT-B-001','${BIZ.B}','P-B-001','팔레트','1200x1000',30,15000,'2026-03-05')
    on conflict (id) do nothing`);
  query(`insert into round_plan (round, book_base, due_date)
    values ('${ROUND}','2026-07','2026-08-13') on conflict (round) do nothing`);
}

/** 어댑터를 새 브라우저처럼 한 벌 올린다 */
function app() {
  const box = { self: null, window: null, console,
    APP_CONFIG: { USE_SUPABASE: true, SUPABASE_URL: "http://local",
                  SUPABASE_ANON_KEY: "local", AUTH_EMAIL_DOMAIN: "vendor.example.com" },
    supabase: { createClient: makeClient }, alert() {}, setTimeout, clearTimeout };
  box.self = box; box.window = box;
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(root, "js/supabase-store.js"), "utf8"), box);
  return box.SupabaseStore;
}

/** 그 사람으로 접속한 것처럼 만들고 자료를 받아 온다 */
let CURRENT_SS = null;
async function asUser(uid) {
  setAuth({ uid });
  const SS = app();
  const doc = await SS.boot(ROUND);
  CURRENT_SS = SS;                 // 아래 appPush 가 이 벌을 쓴다
  return { SS, doc, api: SS.api };
}

/** api.save() 는 결과를 돌려주지 않으므로, 검사에서는 push() 를 직접 기다린다 */
function appPush() { return CURRENT_SS.push(); }

let passed = 0, failed = 0;
const tests = [];
const test = (n, f) => tests.push({ name: n, fn: f });

/* ─────────────────────────────── 검사 ─────────────────────────────── */

test("업체는 자기 업체 정보만 받는다 (남의 업체가 목록에 없다)", async () => {
  const { doc } = await asUser(UID.A);
  assert.strictEqual(doc.vendors.length, 1, "업체 목록에 " + doc.vendors.length + "곳이 왔다");
  assert.strictEqual(doc.vendors[0].bizNo, BIZ.A);
  assert.strictEqual(doc.vendors[0].name, "대한테크");
});

test("업체는 자기 대여 아이템만 받는다", async () => {
  const { doc } = await asUser(UID.A);
  assert.strictEqual(doc.items.length, 2, "아이템이 " + doc.items.length + "건 왔다");
  assert.ok(doc.items.every(i => i.bizNo === BIZ.A), "남의 아이템이 섞였다");
  assert.strictEqual(doc.items[0].partNo, "P-A-001", "품번이 안 왔다");
  assert.strictEqual(doc.items[0].amount, 500000, "금액은 표가 계산한다 (10 × 50,000)");
});

test("담당자는 전부 받는다", async () => {
  const { doc, SS } = await asUser(UID.MGR);
  assert.strictEqual(SS.whoami().role, "hd", "담당자로 판정되지 않았다");
  assert.strictEqual(doc.vendors.length, 2);
  assert.strictEqual(doc.items.length, 3);
});

test("업체가 실사를 만들고 실사수량을 적으면 서버에 남는다", async () => {
  const { doc, api } = await asUser(UID.A);
  doc.audits.push({ id: null, bizNo: BIZ.A, round: ROUND, status: "작성중",
                    submittedAt: null, approvedAt: null });
  await appPush(api);
  setAuth(null);
  const a = (query(`select * from audit where biz_no='${BIZ.A}' and round='${ROUND}'`).data || [])[0];
  assert.ok(a, "실사가 안 만들어졌다");
  assert.strictEqual(a.status, "작성중");
});

test("실사 상세가 저장되고 차이는 표가 계산한다", async () => {
  const { doc, api } = await asUser(UID.A);
  const au = doc.audits[0];
  assert.ok(au && au.id, "실사를 못 받았다");
  doc.auditLines.push(
    { auditId: au.id, itemId: "IT-A-001", partNo: "P-A-001", bookQty: 10, unitPrice: 50000,
      actualQty: 8, reason: "2개 파손", deleteRequested: false, deleteStatus: null,
      correction: "", fault: "", action: "", correctionAmount: 0 },
    { auditId: au.id, itemId: "IT-A-002", partNo: "P-A-002", bookQty: 4, unitPrice: 120000,
      actualQty: 4, reason: "", deleteRequested: false, deleteStatus: null,
      correction: "", fault: "", action: "", correctionAmount: 0 });
  await appPush(api);
  setAuth(null);
  const rows = query(`select * from audit_line where audit_id='${au.id}' order by item_id`).data;
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(Number(rows[0].diff), -2, "차이는 실사-장부 로 표가 계산해야 한다");
  assert.strictEqual(Number(rows[0].amount_diff), -100000, "금액차이가 다르다");
});

test("★ 다른 업체는 그 실사를 볼 수 없다 (격리)", async () => {
  const { doc } = await asUser(UID.B);
  assert.strictEqual(doc.vendors.length, 1);
  assert.strictEqual(doc.vendors[0].bizNo, BIZ.B, "남의 업체가 보인다");
  assert.strictEqual(doc.audits.length, 0, "남의 실사가 " + doc.audits.length + "건 보인다");
  assert.strictEqual(doc.auditLines.length, 0, "남의 실사 상세가 보인다");
  assert.ok(doc.items.every(i => i.bizNo === BIZ.B), "남의 아이템이 보인다");
});

test("★ 다른 업체의 실사수량을 고쳐 쓸 수 없다 (DB 가 막는다)", async () => {
  setAuth(null);
  const au = (query(`select id from audit where biz_no='${BIZ.A}'`).data || [])[0];
  setAuth({ uid: UID.B });
  const r = query(`update audit_line set actual_qty = 999 where audit_id='${au.id}' returning id`);
  setAuth(null);
  const after = (query(`select actual_qty from audit_line
                        where audit_id='${au.id}' and item_id='IT-A-001'`).data || [])[0];
  assert.strictEqual(Number(after.actual_qty), 8, "남이 값을 바꿔 버렸다");
});

test("담당자는 전체 실사를 본다", async () => {
  const { doc } = await asUser(UID.MGR);
  assert.strictEqual(doc.audits.length, 1);
  assert.strictEqual(doc.auditLines.length, 2);
  // 아이템명·규격은 audit_line 에 없다 — rental_item 에서 붙여 와야 화면이 채워진다
  const l = doc.auditLines.filter(x => x.itemId === "IT-A-001")[0];
  assert.strictEqual(l.itemName, "유압호스", "아이템명이 안 붙었다");
  assert.strictEqual(l.spec, "1/2인치");
  assert.strictEqual(l.bizNo, BIZ.A);
});

test("불일치 라인에 소명이 없으면 제출이 막힌다", async () => {
  setAuth(null);
  const au = (query(`select id from audit where biz_no='${BIZ.A}'`).data || [])[0];
  query(`update audit_line set reason = null where audit_id='${au.id}' and item_id='IT-A-001'`);
  const r = query(`update audit set status='제출' where id='${au.id}' returning id`);
  assert.ok(r.error, "소명 없이 제출이 통과했다");
  query(`update audit_line set reason='2개 파손' where audit_id='${au.id}' and item_id='IT-A-001'`);

  // 소명만으로도 아직 부족하다 — 실사결과 확인서 첨부가 있어야 제출이다
  const noAtt = query(`update audit set status='제출' where id='${au.id}' returning id`);
  assert.ok(noAtt.error, "확인서 없이 제출이 통과했다");

  query(`insert into attachment (audit_id, file_name, storage_path, size_bytes, mime_type)
         values ('${au.id}','확인서.pdf','audit-certificates/${BIZ.A}/${ROUND}/확인서.pdf',
                 123456,'application/pdf')`);
  const ok = query(`update audit set status='제출', submitted_at=now() where id='${au.id}' returning status`);
  assert.ok(!ok.error, "소명·확인서를 다 채웠는데도 막혔다: " + (ok.error && ok.error.message));
});

test("담당자가 재고보정 O 를 확정하면 금액을 트리거가 계산한다", async () => {
  const { doc, api } = await asUser(UID.MGR);
  const au = doc.audits[0];
  api.setCorrection(au.id, "IT-A-001", { correction: "O", fault: "협력업체" });
  await appPush(api);
  setAuth(null);
  const l = (query(`select * from audit_line where audit_id='${au.id}' and item_id='IT-A-001'`).data || [])[0];
  assert.strictEqual(l.correction, "O");
  assert.strictEqual(Number(l.correction_amount), -100000, "보정금액을 트리거가 안 채웠다");
  assert.strictEqual(l.action_code, "Z05", "조치사항 기본값이 안 들어갔다");
});

test("보정 대상만 뽑는 뷰가 그 건을 집어낸다", async () => {
  setAuth({ uid: UID.MGR });
  const rows = query("select * from report_correction_list").data;
  assert.ok(rows.length >= 1, "보정요청 리스트가 비었다");
  // 뷰는 correction='O' 인 것만 담는다 — 그 열 자체는 내보내지 않는다.
  const r0 = rows.filter(x => x.biz_no === BIZ.A && x.part_no === "P-A-001")[0];
  assert.ok(r0, "보정 확정한 건이 리스트에 없다");
  assert.strictEqual(Number(r0.correction_amount), -100000, "보정금액이 다르다");
  assert.strictEqual(Number(r0.correction_qty), -2);
  assert.strictEqual(r0.fault, "협력업체");
});

test("★ 업체는 보고서 뷰로도 남의 자료를 볼 수 없다", async () => {
  // 뷰는 기본적으로 **만든 사람의 권한**으로 돈다(security definer 처럼).
  // 그러면 뷰를 읽을 수 있는 사람은 밑에 깔린 표의 RLS 를 통째로 지나쳐
  // 모든 업체의 실사 결과를 보게 된다. 표만 잠그고 뷰를 안 잠그면 헛일이다.
  setAuth({ uid: UID.B });          // 한빛물류
  const sum = query("select * from report_vendor_summary").data || [];
  assert.ok(sum.every(r => r.biz_no === BIZ.B),
    "뷰로 남의 업체가 보인다: " + JSON.stringify(sum.map(r => r.biz_no)));

  const corr = query("select * from report_correction_list").data || [];
  assert.ok(corr.every(r => r.biz_no === BIZ.B),
    "보정 리스트로 남의 자료가 보인다: " + JSON.stringify(corr.map(r => r.biz_no)));

  const pre = query("select * from report_preflight").data || [];
  assert.ok(pre.every(r => !r.biz_no || r.biz_no === BIZ.B),
    "점검표로 남의 자료가 보인다");
});

test("회차 계획을 담당자가 고치면 저장된다", async () => {
  const { api } = await asUser(UID.MGR);
  api.setRoundPlan({ dueDate: "2026-08-20" });
  await appPush(api);
  setAuth(null);
  const p = (query(`select * from round_plan where round='${ROUND}'`).data || [])[0];
  assert.strictEqual(String(p.due_date).slice(0, 10), "2026-08-20");
});

test("★ 업체는 회차 계획을 고칠 수 없다", async () => {
  setAuth({ uid: UID.A });
  query(`update round_plan set due_date='2026-12-31' where round='${ROUND}'`);
  setAuth(null);
  const p = (query(`select * from round_plan where round='${ROUND}'`).data || [])[0];
  assert.strictEqual(String(p.due_date).slice(0, 10), "2026-08-20", "업체가 마감일을 바꿨다");
});

test("바뀐 것이 없으면 아무것도 보내지 않는다", async () => {
  const { api } = await asUser(UID.MGR);
  const n = await appPush(api);
  assert.strictEqual(n, 0, "같은 내용을 다시 보냈다 (" + n + "건)");
});

(async () => {
  seed();
  for (const t of tests) {
    try { await t.fn(); passed++; console.log("  ✔ " + t.name); }
    catch (e) { failed++; console.error("  ✘ " + t.name); console.error("    " + (e && e.message)); }
  }
  setAuth(null);
  console.log("\n결과: " + passed + " 통과, " + failed + " 실패");
  if (failed > 0) process.exit(1);
})();
