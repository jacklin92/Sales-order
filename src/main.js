const { invoke } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;

const TAX_RATE = 0.05;
const DISCLAIMER = '※ 貸款未付清或票據未兌現償清之前，貨物之所有權仍歸屬本公司所有，買受人無異議，同意本公司無需經法律程序隨時可取回本貨品或代物清償。';

const HEADER_IDS = [
  'orderNo', 'orderDate', 'myCompany', 'myPhone', 'myFax', 'myAddress',
  'custName', 'custTaxId', 'custContact', 'custSales', 'custPhone', 'custShipAddr', 'remark', 'taxType',
];
const REQUIRED = { orderNo: '銷貨單號', orderDate: '銷貨日期', myCompany: '我方寶號', custName: '客戶名稱' };
const MY_IDS = ['myCompany', 'myPhone', 'myFax', 'myAddress'];

// 下拉清單（localStorage 記憶，可按鈕編輯）
const LIST_DEFAULTS = { items: [], sizeUnits: ['cm', 'mm', 'm', '吋', '尺'], units: ['面', '式', '個', '組', '張', '本', '份', '套', '只', '條', '箱', '打'] };
const LIST_LABEL = { items: '品項', units: '單位', sizeUnits: '尺寸單位' };
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
  list.forEach(v => { if (v === cur) found = true; opts.push(`<option${v === cur ? ' selected' : ''}>${v}</option>`); });
  if (cur && !found) opts.unshift(`<option selected>${cur}</option>`);
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
      <td><input list="itemsDL" value="${esc(r.name)}" oninput="upd(${i},'name',this.value)"></td>
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

// ---- 驗證 ----
function validate(header, rows) {
  const errs = {};
  for (const k of Object.keys(REQUIRED)) if (!header[k]) errs[k] = '此項必填';
  if (rows.length === 0) errs.rows = '至少需新增一項明細';
  rows.forEach((r, i) => {
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
async function exportExcel(cmd, label) {
  const header = headerData();
  // 依類型自動編號（分開計號、補空號）
  header.orderNo = await computeOrderNo(label);
  document.getElementById('orderNo').value = header.orderNo;
  const errs = validate(header, rows);
  showErrors(errs);
  if (Object.keys(errs).length) return;

  const dir = localStorage.getItem('saveDir') || '';
  const fname = `${label}_${header.orderNo}.xlsx`;
  const path = await dialog.save({
    defaultPath: dir ? dir + '\\' + fname : fname,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  });
  if (!path) return;

  try {
    await invoke(cmd, { header, rows, path });
    saveMyInfo();
    localStorage.setItem('saveDir', path.replace(/[\\/][^\\/]*$/, '')); // 記住此次資料夾
    const file = path.split(/[\\/]/).pop();
    await invoke('append_history', { file, path });
    await loadHistory();
    document.getElementById('orderNo').value = await computeOrderNo(label); // 顯示下一個可用號
    alert('已輸出：' + file);
  } catch (e) { alert('輸出失敗：' + e); }
}
const save = () => exportExcel('save_excel', '銷貨單');
const saveInvoice = () => exportExcel('save_invoice', '請款單');

async function loadFile() {
  const path = await dialog.open({ filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }] });
  if (!path) return;
  try {
    const data = await invoke('load_excel', { path });
    setHeader(data.header);
    rows = data.rows;
    render();
  } catch (e) { alert('載入失敗：' + e); }
}

async function loadHistory() {
  historyList = await invoke('read_history');
  const tbody = document.getElementById('history');
  tbody.innerHTML = '';
  historyList.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="link">${item.file}</td><td>${item.time}</td>`;
    tr.querySelector('.link').onclick = () => invoke('open_file', { path: item.path });
    tbody.appendChild(tr);
  });
}

// ---- 列印（照 Example 版面，預設橫式）----
function toMinguo(s) { const p = (s || '').split('-'); return p.length === 3 ? `${parseInt(p[0], 10) - 1911}/${p[1]}/${p[2]}` : s; }
function printDoc() {
  const h = headerData();
  const size = document.getElementById('paperSize').value;
  const orient = document.getElementById('paperOrient').value;
  document.getElementById('pageStyle').textContent = `@page { size: ${size} ${orient}; margin: 8mm; }`;

  const amount = rows.reduce((s, r) => s + calcSub(r), 0);
  const tax = taxOf(amount);
  const taxLabel = { zero: '零稅率', exempt: '免稅' }[h.taxType] || '營業稅';
  const padded = rows.slice(0, 7);
  while (padded.length < 7) padded.push(null);
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
        <span class="doc-company">${h.myCompany}</span>
        <span class="doc-meta">${h.myAddress}<br>TEL:${h.myPhone} FAX:${h.myFax}</span>
      </div>
      <div class="doc-title">請款單</div>
      <table class="doc-info">
        <tr><td>客戶名稱：${h.custName}</td><td>出貨日期：${toMinguo(h.orderDate)}</td></tr>
        <tr><td>電　　話：${h.custPhone}</td><td>貨單編號：${h.orderNo}</td></tr>
        <tr><td>地　　址：${h.custShipAddr}</td><td>收訖摘要：</td></tr>
      </table>
      <table class="doc-table">
        <thead><tr><th>項目編號</th><th>品名規格</th><th>數量</th><th>單價</th><th>小計</th><th>備註</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <table class="doc-total">
        <tr><td>經辦人：${h.custSales}</td><td>銷貨總額 ${fmt(amount)}</td>
          <td>${taxLabel} ${fmt(tax)}</td><td>總計 ${fmt(amount + tax)}</td></tr>
      </table>
      <div class="doc-note">${DISCLAIMER}</div>
      ${stampUrl ? `<img class="doc-stamp" src="${stampUrl}">` : ''}
    </div>`;
  window.print();
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
computeOrderNo('請款單').then(no => (document.getElementById('orderNo').value = no)); // 預覽下一號
