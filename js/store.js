/**
 * store.js — localStorage 기반 데모 데이터 저장소
 *
 * 실제 운영에서는 Supabase(Postgres + RLS)로 교체한다.
 * (supabase/schema.sql, README의 "Supabase 전환 가이드" 참조)
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'hd_rental_audit_db_v1';
  var CURRENT_ROUND = '2026-08'; // 이번 실사 회차

  // ---------------------------------------------------------------
  // 시드 데이터
  // ---------------------------------------------------------------

  var SEED_VENDORS = [
    { bizNo: '1234567890', name: '대한테크', manager: '김민준', phone: '010-2345-1111', email: 'minjun.kim@daehantech.example.com', password: '1234' },
    { bizNo: '2345678901', name: '한빛물류', manager: '이서연', phone: '010-3456-2222', email: 'seoyeon.lee@hanbit.example.com', password: '1234' },
    { bizNo: '3456789012', name: '서울정공', manager: '박도윤', phone: '010-4567-3333', email: 'doyun.park@seouljg.example.com', password: '1234' },
    { bizNo: '4567890123', name: '미래산업', manager: '최지우', phone: '010-5678-4444', email: 'jiwoo.choi@mirae.example.com', password: '1234' },
    { bizNo: '5678901234', name: '청우전자', manager: '정하은', phone: '010-6789-5555', email: 'haeun.jung@chungwoo.example.com', password: '1234' }
  ];

  // 업체별 대여 아이템 (아이템명, 규격, 장부수량, 단가, 대여일)
  var SEED_ITEMS_BY_VENDOR = {
    '1234567890': [ // 대한테크 (12개) — 미제출 상태로 시작 (데모 워크스루용)
      ['유압잭 리프트', '5T / 수동식', 8, 185000, '2025-11-03'],
      ['전동드릴 세트', 'DC 18V / 비트 32종', 15, 128000, '2025-11-03'],
      ['산업용 선풍기', '650mm / 3엽', 10, 96000, '2025-12-15'],
      ['이동식 작업대', '1200x600 / 접이식', 6, 145000, '2025-12-15'],
      ['안전모', 'ABS / 통풍형', 40, 12000, '2026-01-20'],
      ['LED 투광등', '100W / 방수 IP65', 12, 54000, '2026-01-20'],
      ['용접 보호면', '자동 차광 / DIN 9-13', 9, 68000, '2026-02-11'],
      ['그라인더', '4인치 / 720W', 11, 85000, '2026-02-11'],
      ['레이저 거리측정기', '80m / ±1.5mm', 5, 132000, '2026-03-06'],
      ['공구함 캐비닛', '7단 서랍 / 이동식', 4, 380000, '2026-03-06'],
      ['에어 컴프레서', '30L / 2.5HP', 3, 420000, '2026-04-22'],
      ['연장 릴선', '30m / 4구 누전차단', 14, 47000, '2026-04-22']
    ],
    '2345678901': [ // 한빛물류 (14개) — 전량 일치 제출 완료
      ['핸드 파레트 트럭', '2.5T / 폭 685mm', 6, 320000, '2025-10-14'],
      ['플라스틱 파레트', '1100x1100 / 경량', 60, 28000, '2025-10-14'],
      ['랩핑기 필름 거치대', '수동 / 500mm', 8, 65000, '2025-10-14'],
      ['접이식 대차', '150kg / 알루미늄', 12, 74000, '2025-11-28'],
      ['물류 카트', '4단 / 300kg', 10, 118000, '2025-11-28'],
      ['바코드 스캐너', '무선 2.4GHz / 1D·2D', 15, 94000, '2026-01-09'],
      ['라벨 프린터', '감열식 / 4인치', 7, 210000, '2026-01-09'],
      ['안전 코너가드', '고무 / 800mm', 30, 9500, '2026-02-02'],
      ['컨베이어 롤러', '600mm / 스틸', 20, 56000, '2026-02-02'],
      ['방진 매트', '1200x900 / 15mm', 18, 33000, '2026-02-02'],
      ['이동식 계단', '3단 / 난간형', 4, 265000, '2026-03-17'],
      ['전자 저울', '150kg / 방수형', 6, 187000, '2026-03-17'],
      ['보온 덮개', '파레트용 단열', 25, 41000, '2026-04-05'],
      ['산업용 청소기', '건습식 30L', 5, 235000, '2026-04-05']
    ],
    '3456789012': [ // 서울정공 (13개) — 불일치 + 삭제요청 포함 제출
      ['CNC 바이스', '6인치 / 정밀급', 10, 290000, '2025-09-22'],
      ['버니어 캘리퍼스', '300mm / 디지털', 12, 88000, '2025-09-22'],
      ['마이크로미터', '0-25mm / 0.001', 8, 76000, '2025-09-22'],
      ['탁상 드릴링 머신', '13mm / 375W', 3, 540000, '2025-10-30'],
      ['정반', '600x450 / 석재', 4, 460000, '2025-10-30'],
      ['하이트 게이지', '300mm / 디지털', 5, 340000, '2025-12-01'],
      ['엔드밀 세트', '초경 / 10종', 20, 62000, '2025-12-01'],
      ['절삭유 공급기', '수동 펌프식', 6, 53000, '2026-01-15'],
      ['다이얼 게이지', '0.01mm / 스탠드 포함', 9, 71000, '2026-01-15'],
      ['보루 압축팩', '10kg / 면 혼방', 15, 18000, '2026-02-19'],
      ['체인블록', '1T / 2.5m', 5, 168000, '2026-02-19'],
      ['수평계', '600mm / 알루미늄', 11, 26000, '2026-03-27'],
      ['드릴 척 키트', '13mm / 어댑터 포함', 7, 39000, '2026-03-27']
    ],
    '4567890123': [ // 미래산업 (11개) — 승인 완료
      ['비계 프레임', '1700x1219 / 강관', 40, 45000, '2025-08-18'],
      ['비계 발판', '500x1829 / 아연도금', 60, 32000, '2025-08-18'],
      ['잭 서포트', 'V2 / 3.5m', 50, 21000, '2025-08-18'],
      ['안전 난간대', '1.2m / 클램프식', 35, 17000, '2025-09-25'],
      ['타워 클램프', '고정형 48.6mm', 80, 4500, '2025-09-25'],
      ['낙하물 방지망', '5x10m / 그물', 12, 95000, '2025-11-07'],
      ['안전 그네', '더블 훅 / 벨트식', 25, 84000, '2025-11-07'],
      ['교통 안전콘', 'PE / 700mm', 45, 8000, '2026-01-28'],
      ['이동식 휀스', '아연도금 / 2m', 30, 38000, '2026-01-28'],
      ['발전기', '5kW / 저소음', 2, 980000, '2026-02-24'],
      ['살수기', '반자동 / 60L', 3, 240000, '2026-02-24']
    ],
    '5678901234': [ // 청우전자 (10개) — 미제출
      ['오실로스코프', '100MHz / 2CH', 4, 720000, '2025-10-08'],
      ['디지털 멀티미터', 'True RMS', 14, 65000, '2025-10-08'],
      ['전원 공급기', 'DC 30V 5A / 듀얼', 6, 280000, '2025-11-19'],
      ['납땜 스테이션', '온도조절 / 90W', 10, 115000, '2025-11-19'],
      ['정전기 방지 매트', '600x1200', 16, 42000, '2025-12-23'],
      ['부품 보관함', '44칸 / 투명서랍', 12, 36000, '2025-12-23'],
      ['현미경', '실체 20-40x', 3, 460000, '2026-02-05'],
      ['열풍기', 'SMD 리워크용', 5, 98000, '2026-02-05'],
      ['LCR 미터', '핸디형', 4, 190000, '2026-03-12'],
      ['검사용 지그', '커스텀 / 4포트', 8, 150000, '2026-03-12']
    ]
  };

  /**
   * 시드 DB 생성.
   * 대시보드 데모를 위해 일부 업체는 제출/승인 상태로 미리 채운다.
   *  - 대한테크(123-45-67890): 미제출 → 데모 워크스루 계정
   *  - 한빛물류: 전량 일치 제출
   *  - 서울정공: 불일치 2건 + 삭제 요청 1건 제출
   *  - 미래산업: 승인 완료
   *  - 청우전자: 미제출
   */
  function buildSeed() {
    var items = [];
    Object.keys(SEED_ITEMS_BY_VENDOR).forEach(function (bizNo) {
      SEED_ITEMS_BY_VENDOR[bizNo].forEach(function (row, idx) {
        items.push({
          id: 'IT-' + bizNo.slice(0, 3) + '-' + String(idx + 1).padStart(3, '0'),
          bizNo: bizNo,
          name: row[0],
          spec: row[1],
          qty: row[2],
          unitPrice: row[3],
          amount: row[2] * row[3],
          rentedAt: row[4],
          status: '대여중'
        });
      });
    });

    var audits = [];
    var auditLines = [];
    var attachments = [];
    var notifications = [];

    function findItem(bizNo, name) {
      return items.find(function (i) { return i.bizNo === bizNo && i.name === name; });
    }

    function seedAudit(bizNo, status, submittedAt, overrides) {
      var auditId = 'AU-' + bizNo.slice(0, 3) + '-' + CURRENT_ROUND;
      audits.push({ id: auditId, bizNo: bizNo, round: CURRENT_ROUND, status: status, submittedAt: submittedAt });
      items.filter(function (i) { return i.bizNo === bizNo; }).forEach(function (item) {
        var ov = (overrides || {})[item.name] || {};
        var deleteRequested = !!ov.deleteRequested;
        var actual = deleteRequested ? 0 : (ov.actualQty !== undefined ? ov.actualQty : item.qty);
        var diff = actual - item.qty;
        auditLines.push({
          auditId: auditId,
          itemId: item.id,
          itemName: item.name,
          spec: item.spec,
          bizNo: bizNo,
          bookQty: item.qty,
          unitPrice: item.unitPrice,
          bookAmount: item.qty * item.unitPrice,
          actualQty: actual,
          diff: diff,
          amountDiff: diff * item.unitPrice,
          reason: ov.reason || '',
          deleteRequested: deleteRequested,
          deleteStatus: deleteRequested ? (ov.deleteStatus || '대기') : null
        });
        if (deleteRequested && (ov.deleteStatus === '승인')) item.status = '종료';
        else if (deleteRequested) item.status = '종료요청';
      });
      return auditId;
    }

    // 한빛물류 — 전량 일치 제출
    var au1 = seedAudit('2345678901', '제출', '2026-08-12T10:24:00');
    attachments.push({ auditId: au1, fileName: '한빛물류_실사확인서_2026-08.pdf', size: 482133, type: 'application/pdf', preview: null });
    notifications.push({ id: 'NT-001', to: 'hd-manager@hd.example.com', channel: '이메일', message: '[실사 제출] 한빛물류(234-56-78901)가 2026-08 실사 결과를 제출했습니다. (불일치 0건)', sentAt: '2026-08-12T10:24:05' });

    // 서울정공 — 불일치 2건 + 삭제 요청 1건
    var au2 = seedAudit('3456789012', '제출', '2026-08-14T16:41:00', {
      '버니어 캘리퍼스': { actualQty: 10, reason: '파손 2개 확인 — 폐기 처리 예정, 사진 확인서 첨부' },
      '엔드밀 세트': { actualQty: 18, reason: '마모 한도 초과 2세트 자체 폐기(승인 대기)' },
      '보루 압축팩': { deleteRequested: true, reason: '소모품 전량 사용 완료 — 대여 종료 요청' }
    });
    attachments.push({ auditId: au2, fileName: '서울정공_재고실사확인서.pdf', size: 1204567, type: 'application/pdf', preview: null });
    notifications.push({ id: 'NT-002', to: 'hd-manager@hd.example.com', channel: '이메일', message: '[실사 제출] 서울정공(345-67-89012)이 2026-08 실사 결과를 제출했습니다. (불일치 2건, 삭제 요청 1건)', sentAt: '2026-08-14T16:41:04' });

    // 미래산업 — 불일치 1건 소명 후 승인 완료
    var au3 = seedAudit('4567890123', '승인', '2026-08-08T09:12:00', {
      '타워 클램프': { actualQty: 78, reason: '현장 반출 중 분실 2개 — 변상 처리 협의 중' }
    });
    attachments.push({ auditId: au3, fileName: '미래산업_실사결과_202608.jpg', size: 2381190, type: 'image/jpeg', preview: null });
    notifications.push({ id: 'NT-003', to: 'hd-manager@hd.example.com', channel: '이메일', message: '[실사 제출] 미래산업(456-78-90123)이 2026-08 실사 결과를 제출했습니다. (불일치 1건)', sentAt: '2026-08-08T09:12:03' });
    notifications.push({ id: 'NT-004', to: 'jiwoo.choi@mirae.example.com', channel: '이메일', message: '[실사 승인] 미래산업 2026-08 실사 결과가 승인되었습니다.', sentAt: '2026-08-09T11:02:00' });

    return {
      round: CURRENT_ROUND,
      vendors: SEED_VENDORS.map(function (v) { return Object.assign({}, v); }),
      items: items,
      audits: audits,
      auditLines: auditLines,
      attachments: attachments,
      notifications: notifications,
      seq: 5 // 알림 ID 시퀀스
    };
  }

  // ---------------------------------------------------------------
  // 저장소 API
  // ---------------------------------------------------------------

  var Store = {
    ROUND: CURRENT_ROUND,
    _db: null,

    /** DB 로드 (최초 실행 시 시드 생성) */
    load: function () {
      if (this._db) return this._db;
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          this._db = JSON.parse(raw);
          return this._db;
        }
      } catch (e) { /* 손상된 데이터 → 시드로 재생성 */ }
      this._db = buildSeed();
      this.save();
      return this._db;
    },

    save: function () {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this._db));
      } catch (e) {
        alert('저장 공간이 부족합니다. 첨부 파일 용량을 줄여 주세요.');
      }
    },

    /** 데모 데이터 초기화 */
    reset: function () {
      localStorage.removeItem(STORAGE_KEY);
      this._db = null;
      return this.load();
    },

    /** 알림 로그 기록 (이메일 어댑터 대체 — README 참조) */
    notify: function (to, message) {
      var db = this.load();
      db.seq = (db.seq || 0) + 1;
      db.notifications.push({
        id: 'NT-' + String(db.seq).padStart(3, '0'),
        to: to,
        channel: '이메일',
        message: message,
        sentAt: new Date().toISOString().slice(0, 19)
      });
      this.save();
    }
  };

  global.Store = Store;
})(window);
