const { invoke } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;

const TAX_RATE = 0.05;
const MAX_ROWS = 7; // 版面固定 7 列明細
const DISCLAIMER = '※ 貸款未付清或票據未兌現償清之前，貨物之所有權仍歸屬本公司所有，買受人無異議，同意本公司無需經法律程序隨時可取回本貨品或代物清償。';

const HEADER_IDS = [
  'orderNo', 'orderDate', 'myCompany', 'myPhone', 'myFax', 'myAddress',
  'custName', 'custTaxId', 'custContact', 'custSales', 'custPhone', 'custShipAddr', 'remark', 'taxType', 'docType', 'custAddrType', 'custNote',
];
const REQUIRED = { orderNo: '單據編號', orderDate: '銷貨日期', myCompany: '我方寶號', custName: '客戶名稱' };
const MY_IDS = ['myCompany', 'myPhone', 'myFax', 'myAddress'];

// 下拉清單（localStorage 記憶，可按鈕編輯）
const LIST_DEFAULTS = { items: [], vendors: [], costCats: ['材料', '加工', '運費', '外包', '其他'], sizeUnits: ['cm', 'mm', 'm', '吋', '尺'], units: ['面', '式', '個', '組', '張', '本', '份', '套', '只', '條', '箱', '打'] };
const LIST_LABEL = { items: '品項', vendors: '廠商', costCats: '成本類別', units: '單位', sizeUnits: '尺寸單位' };
function getList(key) { const v = localStorage.getItem('list_' + key); return v ? JSON.parse(v) : LIST_DEFAULTS[key].slice(); }
function setList(key, arr) { localStorage.setItem('list_' + key, JSON.stringify(arr)); }

let rows = [];
let historyList = [];

// ---- 公司章（路徑記於 localStorage；預覽與列印用 Blob URL）----
let stampPath = localStorage.getItem('stampPath') || '';
let stampUrl = '';
async function loadStamp() {
  const img = document.getElementById('stampPreview');
  stampUrl = '';
  if (stampPath) {
    try { stampUrl = URL.createObjectURL(new Blob([await invoke('read_file', { path: stampPath })])); }
    catch (e) { stampPath = ''; localStorage.removeItem('stampPath'); }
  }
  img.src = stampUrl;
  img.style.display = stampUrl ? 'block' : 'none';
}
async function pickStamp() {
  const path = await dialog.open({ filters: [{ name: '圖檔', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] }] });
  if (!path) return;
  stampPath = path; localStorage.setItem('stampPath', path);
  await loadStamp();
}
function clearStamp() { stampPath = ''; localStorage.removeItem('stampPath'); loadStamp(); }

// 單號 = 出貨日 YYYYMMDD + 流水號；流水號依「存檔資料夾內該類型現有檔案」取最小空號（分型別、刪檔可補回）
async function computeOrderNo(label) {
  const prefix = (val('orderDate') || today()).replace(/-/g, '');
  const dir = localStorage.getItem('saveDir') || '';
  let seq = 1;
  if (dir) {
    try { seq = await invoke('next_seq', { dir, label, prefix }); } catch (e) { /* 資料夾不存在則用 1 */ }
  }
  return prefix + String(seq).padStart(3, '0');
}

// ---- 表頭 ----
function val(id) { return document.getElementById(id).value.trim(); }
function headerData() { const h = {}; HEADER_IDS.forEach(id => (h[id] = val(id))); h.stamp = stampPath; return h; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function setHeader(h) { HEADER_IDS.forEach(id => (document.getElementById(id).value = h[id] || '')); }

// 我方資訊記憶於 localStorage，下次開啟自動帶入
function saveMyInfo() { MY_IDS.forEach(id => localStorage.setItem(id, val(id))); }
function loadMyInfo() {
  MY_IDS.forEach(id => {
    const v = localStorage.getItem(id);
    if (v) document.getElementById(id).value = v;
  });
}

// ---- 明細 ----
function addRow() { rows.push({ name: '', size: '', sizeUnit: getList('sizeUnits')[0] || '', unit: '', qty: 1, price: 0 }); render(); }
function delRow(i) { rows.splice(i, 1); render(); }
function calcSub(r) { return (Number(r.qty) || 0) * (Number(r.price) || 0); }

// 下拉選項；目前值不在清單內時補一個選項以免遺失
function optionHtml(list, cur) {
  const opts = ['<option value=""></option>'];
  let found = false;
  list.forEach(v => { if (v === cur) found = true; opts.push(`<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`); });
  if (cur && !found) opts.unshift(`<option value="${esc(cur)}" selected>${esc(cur)}</option>`);
  return opts.join('');
}

function render() {
  const tbody = document.getElementById('rows');
  tbody.innerHTML = '';
  const units = getList('units'), sizeUnits = getList('sizeUnits');
  document.getElementById('itemsDL').innerHTML = getList('items').map(v => `<option value="${esc(v)}">`).join('');
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="right">${i + 1}</td>
      <td><input class="nm-in" list="itemsDL" value="${esc(r.name)}" oninput="upd(${i},'name',this.value)"></td>
      <td><input class="size" value="${esc(r.size)}" oninput="upd(${i},'size',this.value)"></td>
      <td><select class="narrow" onchange="upd(${i},'sizeUnit',this.value)">${optionHtml(sizeUnits, r.sizeUnit)}</select></td>
      <td><select class="narrow" onchange="upd(${i},'unit',this.value)">${optionHtml(units, r.unit)}</select></td>
      <td><input class="num" type="number" value="${r.qty}" oninput="upd(${i},'qty',this.value)"></td>
      <td><input class="num" type="number" value="${r.price}" oninput="upd(${i},'price',this.value)"></td>
      <td class="right" id="sub-${i}">${fmt(calcSub(r))}</td>
      <td><button tabindex="-1" onclick="delRow(${i})">刪</button></td>`;
    tbody.appendChild(tr);
  });
  recalc();
}
// 只更新計算結果，不重建 input/select，才能保留焦點與 Tab 流程
// 稅額：應稅 5%，零稅率／免稅為 0
function taxOf(amount) { return ['zero', 'exempt'].includes(val('taxType')) ? 0 : Math.round(amount * TAX_RATE); }
function recalc() {
  let amount = 0;
  rows.forEach((r, i) => {
    const s = calcSub(r);
    amount += s;
    const el = document.getElementById('sub-' + i);
    if (el) el.textContent = fmt(s);
  });
  const tax = taxOf(amount);
  document.getElementById('sumAmount').textContent = fmt(amount);
  document.getElementById('sumTax').textContent = fmt(tax);
  document.getElementById('sumTotal').textContent = fmt(amount + tax);
}
function upd(i, key, value) {
  rows[i][key] = (key === 'qty' || key === 'price') ? (Number(value) || 0) : value;
  recalc();
}

// ---- 清單編輯 ----
let editingKey = null;
function editList(key) {
  editingKey = key;
  document.getElementById('listTitle').textContent = '編輯' + LIST_LABEL[key] + '清單（每行一項）';
  document.getElementById('listText').value = getList(key).join('\n');
  document.getElementById('listModal').style.display = 'flex';
  document.getElementById('listText').focus();
}
function saveList() {
  setList(editingKey, document.getElementById('listText').value.split('\n').map(s => s.trim()).filter(Boolean));
  closeList();
  render();
  if (po) renderPo();
}
function closeList() { document.getElementById('listModal').style.display = 'none'; }

function showHelp() { document.getElementById('helpModal').style.display = 'flex'; }
function closeHelp() { document.getElementById('helpModal').style.display = 'none'; }

// ---- 外觀自訂（各區塊顏色，localStorage 記憶）----
const THEME_VARS = [
  { v: '--bg', label: '背景', def: '#05080d' },
  { v: '--panel', label: '區塊底色', def: '#28323f' },
  { v: '--panel-edge', label: '區塊邊框', def: '#5a6b82' },
  { v: '--field-bg', label: '輸入框底色', def: '#ffffff' },
  { v: '--field-edge', label: '輸入框邊框', def: '#0b1220' },
  { v: '--txt', label: '文字', def: '#f4f7fb' },
  { v: '--accent', label: '重點色', def: '#2dd4ee' },
];
function getTheme() { const v = localStorage.getItem('theme'); return v ? JSON.parse(v) : {}; }
function applyTheme() {
  const t = getTheme();
  THEME_VARS.forEach(d => document.documentElement.style.setProperty(d.v, t[d.v] || d.def));
}
function openTheme() {
  const t = getTheme();
  document.getElementById('themeRows').innerHTML = THEME_VARS.map(d => {
    const val = t[d.v] || d.def;
    return `<label class="theme-row"><span>${d.label}</span>
      <input type="color" value="${val}" oninput="setVar('${d.v}',this)"><code>${val}</code></label>`;
  }).join('');
  document.getElementById('themeModal').style.display = 'flex';
}
function setVar(name, el) {
  document.documentElement.style.setProperty(name, el.value);
  const t = getTheme(); t[name] = el.value; localStorage.setItem('theme', JSON.stringify(t));
  el.nextElementSibling.textContent = el.value;
}
function resetTheme() {
  localStorage.removeItem('theme');
  THEME_VARS.forEach(d => document.documentElement.style.setProperty(d.v, d.def));
  openTheme();
}
function closeTheme() { document.getElementById('themeModal').style.display = 'none'; }

// ---- 進貨單與毛利彙總（內部用，不進 Excel 與列印）----
// 資料存 app 資料夾：purchases.json（進貨單，key=進貨單號）、sales.json（儲存單據時記的銷貨摘要，key=類型_單號）
let purchases = {}, salesIdx = {};
let po = null, poNew = true, poDirty = false, poShown = 10;
const PIE_COLORS = ['#f59e0b', '#60a5fa', '#a78bfa', '#f472b6', '#fb7185', '#2dd4ee', '#fbbf24', '#94a3b8'];
const PROFIT_COLOR = '#34d399';
const E = id => document.getElementById(id);
const salesAmount = () => rows.reduce((s, r) => s + calcSub(r), 0);
const poAmount = p => p.rows.reduce((s, r) => s + calcSub(r), 0);
const poTax = (amount, type) => ['zero', 'exempt'].includes(type) ? 0 : Math.round(amount * TAX_RATE);
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

// 儲存單據時記一筆銷貨摘要（進貨單「對應銷貨單」用）
async function recordSale(h) {
  try {
    await invoke('write_store', { name: 'sales', key: `${h.docType}_${h.orderNo}`, data: {
      docType: h.docType, orderNo: h.orderNo, custName: h.custName, date: h.orderDate,
      amount: salesAmount(), saved: new Date().toISOString(),
    } });
  } catch (e) { console.error('銷貨摘要寫入失敗', e); }
}
async function loadStores() {
  try {
    purchases = await invoke('read_store', { name: 'purchases' });
    salesIdx = await invoke('read_store', { name: 'sales' });
  } catch (e) { alert('讀取進貨資料失敗：' + e); }
}

async function showPage(p) {
  const cost = p === 'cost';
  if (!cost && !(await leavePo())) return;
  if (cost) { await loadStores(); if (!po) newPo(); }
  E('salesPage').style.display = cost ? 'none' : '';
  E('costPage').style.display = cost ? '' : 'none';
  document.body.classList.toggle('cost', cost);
  E('appTitle').textContent = cost ? '進貨成本與毛利' : '通用銷貨明細系統';
  E('navSales').classList.toggle('on', !cost);
  E('navCost').classList.toggle('on', cost);
  if (cost) renderPo();
}

// 進貨單號 = P + 進貨日 YYYYMMDD + 流水號（取最小空號）
function poNoFor(date) {
  const prefix = 'P' + (date || today()).replace(/-/g, '');
  const used = new Set(Object.keys(purchases).filter(k => k.startsWith(prefix)).map(k => Number(k.slice(prefix.length))));
  let n = 1;
  while (used.has(n)) n++;
  return prefix + String(n).padStart(3, '0');
}
function newPo() {
  po = { no: '', date: today(), vendor: '', link: '', rows: [], taxType: 'taxable' };
  po.no = poNoFor(po.date);
  poNew = true; poDirty = false;
}
const poHasContent = () => po.vendor.trim() || po.rows.some(r => r.name.trim() || calcSub(r));
function poError() {
  if (!po.vendor.trim()) return '請填廠商';
  if (!po.rows.length) return '至少需新增一項進貨明細';
  const i = po.rows.findIndex(r => !r.name.trim() || !(Number(r.qty) > 0) || !(Number(r.price) >= 0));
  return i >= 0 ? `第 ${i + 1} 列：品名、數量、單價為必填` : '';
}
async function savePo(silent) {
  const err = poError();
  if (err) { alert(err); return false; }
  const data = { poNo: po.no, date: po.date || today(), vendor: po.vendor.trim(), link: po.link, rows: po.rows, taxType: po.taxType, saved: new Date().toISOString() };
  try { await invoke('write_store', { name: 'purchases', key: po.no, data }); }
  catch (e) { alert('儲存進貨單失敗：' + e); return false; }
  purchases[po.no] = data;
  poNew = false; poDirty = false;
  renderPo();
  if (silent !== true) alert('已儲存進貨單：' + po.no);
  return true;
}
// 離開目前進貨單（切頁、新增、改編他張）前：完整則自動儲存，不完整則詢問是否捨棄；false 表示留下
async function leavePo() {
  if (!po || !poDirty) return true;
  if (!poError()) return savePo(true);
  if (!poHasContent()) return true;
  return confirm(`目前進貨單資料不完整（${poError()}），離開會捨棄，確定離開？`);
}
async function addPo() { if (!(await leavePo())) return; newPo(); renderPo(); }
async function delPo() {
  if (!confirm(`刪除進貨單「${po.no}」？`)) return;
  if (!poNew) {
    try { await invoke('write_store', { name: 'purchases', key: po.no, data: null }); }
    catch (e) { alert('刪除失敗：' + e); return; }
    delete purchases[po.no];
  }
  newPo(); renderPo();
}
async function editPo(key) {
  if (!(await leavePo())) return;
  const d = purchases[key];
  po = { no: d.poNo, date: d.date, vendor: d.vendor, link: d.link || '', rows: JSON.parse(JSON.stringify(d.rows)), taxType: d.taxType || 'taxable' };
  poNew = false; poDirty = false;
  renderPo();
  window.scrollTo(0, 0);
}
function setPoField(k, v) {
  po[k] = v; poDirty = true;
  if (k === 'date' && poNew) { po.no = poNoFor(v); E('poNo').value = po.no; }
  calcPo();
}
function addPoRow() { po.rows.push({ cat: getList('costCats')[0] || '', name: '', unit: '', qty: 1, price: 0 }); poDirty = true; renderPo(); }
function delPoRow(i) { po.rows.splice(i, 1); poDirty = true; renderPo(); }
function updPoRow(i, k, v) {
  po.rows[i][k] = (k === 'qty' || k === 'price') ? (Number(v) || 0) : v;
  poDirty = true;
  calcPo();
}

function renderPo() {
  E('poNo').value = po.no;
  E('poDate').value = po.date;
  E('poVendor').value = po.vendor;
  E('pTaxType').value = po.taxType;
  E('vendorDL').innerHTML = getList('vendors').map(v => `<option value="${esc(v)}">`).join('');
  const keys = Object.keys(salesIdx).sort((a, b) => (salesIdx[b].saved || '').localeCompare(salesIdx[a].saved || ''));
  if (po.link && !keys.includes(po.link)) keys.unshift(po.link);
  E('poLink').innerHTML = '<option value="">（不對應）</option>' + keys.map(k => {
    const s = salesIdx[k];
    return `<option value="${esc(k)}"${k === po.link ? ' selected' : ''}>${esc(k)}${s ? '　' + esc(s.custName) + '　' + fmt(s.amount) : ''}</option>`;
  }).join('');
  const cats = getList('costCats'), units = getList('units');
  E('poRows').innerHTML = po.rows.map((r, i) => `<tr>
    <td class="right">${i + 1}</td>
    <td><select class="narrow" onchange="updPoRow(${i},'cat',this.value)">${optionHtml(cats, r.cat)}</select></td>
    <td><input class="nm-in" value="${esc(r.name)}" oninput="updPoRow(${i},'name',this.value)"></td>
    <td><select class="narrow" onchange="updPoRow(${i},'unit',this.value)">${optionHtml(units, r.unit)}</select></td>
    <td><input class="num" type="number" value="${r.qty}" oninput="updPoRow(${i},'qty',this.value)"></td>
    <td><input class="num" type="number" value="${r.price}" oninput="updPoRow(${i},'price',this.value)"></td>
    <td class="right" id="psub-${i}">${fmt(calcSub(r))}</td>
    <td><button tabindex="-1" onclick="delPoRow(${i})">刪</button></td></tr>`).join('');
  calcPo();
  renderAgg();
}
// 只更新計算結果，不重建輸入欄（保留焦點）
function calcPo() {
  po.rows.forEach((r, i) => { const el = E('psub-' + i); if (el) el.textContent = fmt(calcSub(r)); });
  const amount = poAmount(po), tax = poTax(amount, po.taxType);
  E('pSumAmount').textContent = fmt(amount);
  E('pSumTax').textContent = fmt(tax);
  E('pSumTotal').textContent = fmt(amount + tax);
  const s = salesIdx[po.link];
  if (!po.link) E('poLinkInfo').textContent = '未對應銷貨單：只計入進貨成本，不算毛利。';
  else if (!s) E('poLinkInfo').textContent = '找不到該銷貨單的摘要。';
  else {
    const cost = sum(Object.values(purchases).filter(p => p.link === po.link && p.poNo !== po.no), poAmount) + amount;
    const profit = s.amount - cost;
    E('poLinkInfo').innerHTML = `對應 <b>${esc(po.link)}</b>（${esc(s.custName)}）　銷貨額（未稅）<b>${fmt(s.amount)}</b>　` +
      `此銷貨單累計進貨額（含本單）<b>${fmt(cost)}</b>　${profit < 0 ? '虧損' : '毛利'}<b>${fmt(Math.abs(profit))}</b>` +
      `（${s.amount > 0 ? (profit / s.amount * 100).toFixed(1) + '%' : '-'}）`;
  }
}

// ---- 彙總（日期區間內所有進貨單）----
function aggChanged() { poShown = 10; renderAgg(); }
function aggClear() { E('aFrom').value = ''; E('aTo').value = ''; aggChanged(); }
function poMore() { poShown += 10; renderAgg(); }
function renderAgg() {
  const from = E('aFrom').value, to = E('aTo').value;
  const list = Object.values(purchases)
    .filter(p => (!from || p.date >= from) && (!to || p.date <= to))
    .sort((a, b) => (b.date + b.poNo).localeCompare(a.date + a.poNo));
  const total = sum(list, poAmount);
  const hasSale = p => p.link && salesIdx[p.link];
  const linkedKeys = new Set(list.filter(hasSale).map(p => p.link));
  const revenue = sum([...linkedKeys], k => salesIdx[k].amount);
  const linkedPos = Object.values(purchases).filter(p => linkedKeys.has(p.link)); // 含區間外的對應進貨單，毛利才完整
  const linkedCost = sum(linkedPos, poAmount);
  const profit = revenue - linkedCost;
  const card = (t, v, cls = '') => `<div>${t}<b class="${cls}">${v}</b></div>`;
  E('aSum').innerHTML = card('進貨單數', list.length) + card('進貨總額（未稅）', fmt(total)) +
    card('已對應銷貨額（未稅）', fmt(revenue)) + card('對應進貨額（未稅）', fmt(linkedCost)) +
    card(profit < 0 ? '虧損' : '毛利', fmt(Math.abs(profit)), profit < 0 ? 'loss' : '') +
    card('毛利率', revenue > 0 ? (profit / revenue * 100).toFixed(1) + '%' : '-', profit < 0 ? 'loss' : '');
  const unlinked = list.filter(p => !hasSale(p));
  E('aNote').textContent = unlinked.length
    ? `區間內有 ${unlinked.length} 張進貨單未對應銷貨單（共 ${fmt(sum(unlinked, poAmount))} 元），不計入毛利。` : '';

  // 圓餅：進貨組成（區間內全部），或「已對應銷貨單的進貨組成＋毛利」
  const by = E('aBy').value, mode = E('aMode').value;
  const src = mode === 'profit' ? linkedPos : list;
  const groups = {};
  src.forEach(p => p.rows.forEach(r => {
    const k = (by === 'vendor' ? p.vendor : r[by]) || '（未填）';
    groups[k] = (groups[k] || 0) + calcSub(r);
  }));
  const items = Object.entries(groups).filter(([, v]) => v > 0)
    .map(([label, value], i) => ({ label, value, color: PIE_COLORS[i % PIE_COLORS.length] }));
  if (mode === 'profit' && profit > 0) items.push({ label: '毛利', value: profit, color: PROFIT_COLOR });
  drawPie(items);

  // 清單
  const tbody = E('poList');
  tbody.innerHTML = '';
  list.slice(0, poShown).forEach(p => {
    const s = salesIdx[p.link];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="link">${esc(p.poNo)}</td><td>${esc(p.date)}</td><td>${esc(p.vendor)}</td>` +
      `<td class="right">${fmt(poAmount(p))}</td><td>${p.link ? esc(p.link) + (s ? '　' + esc(s.custName) : '') : '—'}</td>`;
    tr.querySelector('.link').onclick = () => editPo(p.poNo);
    tbody.appendChild(tr);
  });
  E('poMore').style.display = list.length > poShown ? '' : 'none';
}
function drawPie(items) {
  const pie = E('pie'), legend = E('pieLegend');
  const total = sum(items, x => x.value);
  if (!total) { pie.innerHTML = '<p class="muted">尚無進貨資料</p>'; legend.innerHTML = ''; return; }
  const R = 90;
  let a0 = -Math.PI / 2, svg = '';
  items.forEach(x => {
    const a1 = a0 + x.value / total * 2 * Math.PI;
    if (items.length === 1) {
      svg += `<circle cx="100" cy="100" r="${R}" style="fill:${x.color}"/>`;
    } else {
      const large = a1 - a0 > Math.PI ? 1 : 0;
      svg += `<path d="M100 100 L${100 + R * Math.cos(a0)} ${100 + R * Math.sin(a0)} A${R} ${R} 0 ${large} 1 ${100 + R * Math.cos(a1)} ${100 + R * Math.sin(a1)} Z" style="fill:${x.color};stroke:var(--panel);stroke-width:2"/>`;
    }
    a0 = a1;
  });
  pie.innerHTML = `<svg viewBox="0 0 200 200" width="260" height="260">${svg}</svg>`;
  legend.innerHTML = items.map(x =>
    `<div class="lg"><i style="background:${x.color}"></i>${esc(x.label)}<span>${fmt(x.value)}（${(x.value / total * 100).toFixed(1)}%）</span></div>`).join('');
}

// ---- 驗證 ----
function validate(header, rows) {
  const errs = {};
  for (const k of Object.keys(REQUIRED)) if (!header[k]) errs[k] = '此項必填';
  if (rows.length === 0) errs.rows = '至少需新增一項明細';
  if (rows.length > MAX_ROWS) errs.rows = `明細最多 ${MAX_ROWS} 筆（版面固定 ${MAX_ROWS} 列），請刪除 ${rows.length - MAX_ROWS} 筆`;
  rows.slice(0, MAX_ROWS).forEach((r, i) => {
    if (!r.name?.trim() || !(Number(r.qty) > 0) || !(Number(r.price) >= 0))
      errs.rows = `第 ${i + 1} 列：品名、數量、單價為必填`;
  });
  return errs;
}
function showErrors(errs) {
  for (const k of Object.keys(REQUIRED))
    document.getElementById('err-' + k).textContent = errs[k] || '';
  document.getElementById('err-rows').textContent = errs.rows || '';
}

// ---- 後端互動 ----
// 檔名：{類型}_{單號}[-客戶註記]（註記中檔名不可用的字元換成底線）
function fileStem(h) {
  const note = (h.custNote || '').replace(/[\\/:*?"<>|]/g, '_').trim();
  return `${h.docType}_${h.orderNo}${note ? '-' + note : ''}`;
}
function refreshOrderNo() { computeOrderNo(val('docType')).then(no => (document.getElementById('orderNo').value = no)); }

async function saveDoc() {
  if (stampPath) {
    await loadStamp(); // 檔案已被移走時會清除設定
    if (!stampPath) alert('找不到公司章圖檔，本次輸出不含公司章，請重新選擇圖檔');
  }
  const header = headerData();
  // 依單據類型自動編號（分開計號、補空號）
  header.orderNo = await computeOrderNo(header.docType);
  document.getElementById('orderNo').value = header.orderNo;
  const errs = validate(header, rows);
  showErrors(errs);
  if (Object.keys(errs).length) return;

  if (document.getElementById('outFormat').value === 'pdf') {
    // PDF：呼叫系統列印，印表機選「Microsoft Print to PDF」；WebView2 以網頁標題作預設檔名
    const old = document.title;
    await recordSale(header);
    document.title = fileStem(header);
    window.addEventListener('afterprint', () => (document.title = old), { once: true });
    printDoc();
    return;
  }

  const dir = localStorage.getItem('saveDir') || '';
  const fname = `${fileStem(header)}.xlsx`;
  const path = await dialog.save({
    defaultPath: dir ? dir + '\\' + fname : fname,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  });
  if (!path) return;

  try {
    await invoke('save_form', { header, rows, path });
    await recordSale(header);
    saveMyInfo();
    localStorage.setItem('saveDir', path.replace(/[\\/][^\\/]*$/, '')); // 記住此次資料夾
    const file = path.split(/[\\/]/).pop();
    await invoke('append_history', { file, path });
    await loadHistory();
    refreshOrderNo(); // 顯示下一個可用號
    alert('已輸出：' + file);
  } catch (e) { alert('輸出失敗：' + e); }
}

async function loadFile() {
  const path = await dialog.open({ filters: [
    { name: 'Excel 或 PDF', extensions: ['xlsx', 'xls', 'pdf'] },
    { name: 'Excel', extensions: ['xlsx', 'xls'] },
    { name: 'PDF', extensions: ['pdf'] },
  ] });
  if (!path) return;
  if (/\.pdf$/i.test(path)) { // PDF 無固定欄位座標，只用預設程式檢視
    try { await invoke('open_file', { path }); } catch (e) { alert('開啟失敗：' + e); }
    return;
  }
  try {
    const data = await invoke('load_excel', { path });
    setHeader(data.header);
    // 客戶註記存在檔名：{類型}_{11位單號}-{註記}.xlsx
    const m = path.split(/[\\/]/).pop().match(/^.+?_\d{11}-(.+)\.xlsx?$/);
    document.getElementById('custNote').value = m ? m[1] : '';
    rows = data.rows;
    render();
  } catch (e) { alert('載入失敗：' + e); }
}

// 歷史：預設最近 10 筆，可「顯示更多」或依日期查看更早的
let histShown = 10;
async function loadHistory() { historyList = await invoke('read_history'); renderHistory(); }
function renderHistory() {
  const d = document.getElementById('histDate').value;
  const list = d ? historyList.filter(i => i.time.startsWith(d)) : historyList;
  const tbody = document.getElementById('history');
  tbody.innerHTML = '';
  (d ? list : list.slice(0, histShown)).forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="link">${esc(item.file)}</td><td>${esc(item.time)}</td>`;
    tr.querySelector('.link').onclick = () => invoke('open_file', { path: item.path });
    tbody.appendChild(tr);
  });
  document.getElementById('histMore').style.display = !d && list.length > histShown ? '' : 'none';
}
function histMore() { histShown += 10; renderHistory(); }
function histClear() { document.getElementById('histDate').value = ''; histShown = 10; renderHistory(); }

// ---- 列印（照 Example 版面，預設橫式）----
function toMinguo(s) { const p = (s || '').split('-'); return p.length === 3 ? `${parseInt(p[0], 10) - 1911}/${p[1]}/${p[2]}` : s; }
function printDoc() {
  if (rows.length > MAX_ROWS) { alert(`明細最多 ${MAX_ROWS} 筆（版面固定 ${MAX_ROWS} 列），請先刪除多餘項目`); return; }
  const h = headerData();
  const size = document.getElementById('paperSize').value;
  const orient = document.getElementById('paperOrient').value;
  document.getElementById('pageStyle').textContent = `@page { size: ${size} ${orient}; margin: 8mm; }`;

  const amount = rows.reduce((s, r) => s + calcSub(r), 0);
  const tax = taxOf(amount);
  const taxLabel = { zero: '零稅率', exempt: '免稅' }[h.taxType] || '營業稅';
  const padded = rows.slice(0, MAX_ROWS);
  while (padded.length < MAX_ROWS) padded.push(null);
  // 備註欄：第 1~5 列合併放備註，第 6 列「客戶簽收」，第 7 列空白
  const noteCell = i => i === 0 ? `<td rowspan="5" class="remark">${esc(h.remark)}</td>` : i < 5 ? '' : i === 5 ? '<td>客戶簽收</td>' : '<td></td>';
  const body = padded.map((r, i) => {
    if (!r) return `<tr><td></td><td></td><td></td><td></td><td></td>${noteCell(i)}</tr>`;
    return `<tr><td>${i + 1}</td><td class="nm">${esc(r.name)}${r.size ? esc(r.size) + esc(r.sizeUnit) : ''}</td><td>${r.qty}${esc(r.unit)}</td>
      <td class="right">${fmt(r.price)}</td><td class="right">${fmt(calcSub(r))}</td>${noteCell(i)}</tr>`;
  }).join('');

  document.getElementById('printArea').innerHTML = `
    <div class="doc">
      <div class="doc-head">
        <span class="doc-cust">客戶編號：</span>
        <span class="doc-company">${esc(h.myCompany)}</span>
        <span class="doc-meta">${esc(h.myAddress)}<br>TEL:${esc(h.myPhone)} FAX:${esc(h.myFax)}</span>
      </div>
      <div class="doc-title">${esc(h.docType)}</div>
      <table class="doc-info">
        <tr><td>客戶名稱：${esc(h.custName)}</td><td>出貨日期：${toMinguo(h.orderDate)}</td></tr>
        <tr><td>電　　話：${esc(h.custPhone)}</td><td>貨單編號：${esc(h.orderNo)}</td></tr>
        <tr><td>${esc(h.custAddrType || '客戶地址')}：${esc(h.custShipAddr)}</td><td>收訖摘要：</td></tr>
      </table>
      <table class="doc-table">
        <thead><tr><th>項目編號</th><th>品名規格</th><th>數量</th><th>單價</th><th>小計</th><th>備註</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <table class="doc-total">
        <tr><td>經辦人：${esc(h.custSales)}</td><td>銷貨總額 ${fmt(amount)}</td>
          <td>${taxLabel} ${fmt(tax)}</td><td>總計 ${fmt(amount + tax)}</td></tr>
      </table>
      <div class="doc-note">${DISCLAIMER}</div>
      ${stampUrl ? `<img class="doc-stamp" src="${stampUrl}">` : ''}
    </div>`;
  window.print();
}

// ---- 自動更新（GitHub Release 的 latest.json；簽章驗證由 updater 外掛處理）----
async function checkUpdate(manual) {
  try {
    const update = await window.__TAURI__.updater.check();
    if (!update) { if (manual) alert('目前已是最新版'); return; }
    const notes = update.body ? `\n\n更新內容：\n${update.body}` : '';
    if (!confirm(`有新版本 ${update.version}（目前 ${update.currentVersion}）。${notes}\n\n更新後程式會自動重新啟動，尚未存檔的內容會遺失，請先存檔。\n要現在更新嗎？`)) return;
    await update.downloadAndInstall();
    await window.__TAURI__.process.relaunch();
  } catch (e) {
    if (manual) alert('檢查更新失敗：' + e); // 啟動時自動檢查失敗（例如沒網路）不打擾使用者
  }
}

// ---- 工具 ----
function fmt(n) { return (Number(n) || 0).toLocaleString('zh-TW'); }
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 啟動
applyTheme();
document.getElementById('orderDate').value = today();
loadMyInfo();
loadStamp();
addRow();
loadHistory();
refreshOrderNo(); // 預覽下一號
checkUpdate(false); // 啟動時背景檢查更新
