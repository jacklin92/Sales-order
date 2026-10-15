#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use calamine::{open_workbook_auto, Data, DataType, Reader};
use serde::{Deserialize, Serialize};
use std::fs::{create_dir_all, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use tauri::Manager;
use umya_spreadsheet as umya;
use umya_spreadsheet::{Border, HorizontalAlignmentValues as HA, VerticalAlignmentValues as VA};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Header {
    order_no: String,
    order_date: String,
    my_company: String,
    my_phone: String,
    my_fax: String,
    my_address: String,
    cust_name: String,
    cust_tax_id: String,
    cust_contact: String,
    cust_sales: String,
    cust_phone: String,
    cust_ship_addr: String,
    #[serde(default)]
    remark: String,
    #[serde(default)]
    stamp: String, // 公司章圖檔路徑，空字串表示不加
    #[serde(default)]
    doc_type: String, // 報價單／請款單／銷貨單；空值或未知視為銷貨單
    #[serde(default)]
    cust_addr_type: String, // 公司地址／安裝地址／客戶地址；空值視為客戶地址
    #[serde(default)]
    tax_type: String, // taxable 應稅5% / zero 零稅率 / exempt 免稅；空值視為應稅
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Row {
    name: String,
    unit: String,
    #[serde(default)]
    size: String, // 尺寸，輸出時接在品名後
    #[serde(default)]
    size_unit: String,
    qty: f64,
    price: f64,
}

const DOC_TYPES: [&str; 3] = ["報價單", "請款單", "銷貨單"];
const ADDR_TYPES: [&str; 3] = ["公司地址", "安裝地址", "客戶地址"];

#[tauri::command]
fn save_form(header: Header, rows: Vec<Row>, path: String) -> Result<(), String> {
    let title = DOC_TYPES.iter().find(|t| **t == header.doc_type).unwrap_or(&"銷貨單");
    write_form(title, &header, &rows, &path)
}

// 西元 YYYY-MM-DD 轉民國 yyy/mm/dd；解析失敗則原樣回傳
fn to_minguo(s: &str) -> String {
    let p: Vec<&str> = s.split('-').collect();
    match (p.first().and_then(|y| y.parse::<i32>().ok()), p.get(1), p.get(2)) {
        (Some(y), Some(m), Some(d)) => format!("{}/{}/{}", y - 1911, m, d),
        _ => s.to_string(),
    }
}

fn fontset(sheet: &mut umya::Worksheet, coord: (u32, u32), name: &str, size: f64) {
    let f = sheet.get_cell_mut(coord).get_style_mut().get_font_mut();
    f.set_name(name);
    f.set_size(size);
    f.get_color_mut().set_argb("FF000000");
}
// side: t/b/l/r；style 用 Border::BORDER_* 常數
fn edge(sheet: &mut umya::Worksheet, coord: (u32, u32), side: &str, style: &str) {
    let b = sheet.get_cell_mut(coord).get_style_mut().get_borders_mut();
    let bd = match side {
        "t" => b.get_top_mut(),
        "b" => b.get_bottom_mut(),
        "l" => b.get_left_mut(),
        _ => b.get_right_mut(),
    };
    black_side(bd, style);
}
fn black_side(bd: &mut Border, style: &str) {
    bd.set_border_style(style);
    bd.get_color_mut().set_argb("FF000000");
}
fn num_int(n: f64) -> String {
    if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{n}") }
}

// 照 Example.xls 排版（銷貨單/請款單共用，只差標題）：固定 7 列明細、四種字體、整單一次營業稅 5%
const F_LABEL: &str = "超研澤中圓"; // 抬頭標籤、寶號、表頭
const F_DATE: &str = "華康中明體"; // 出貨日期/貨單編號/收訖摘要
const F_BODY: &str = "新細明體"; // 明細數字、合計、聲明
const F_KAI: &str = "標楷體"; // 數量、備註
const DISCLAIMER: &str = "  ***  貸款未付清或票據未兌現償清之前,貨物之所有權仍歸屬本公司所有,買受人無異議,同意本公司無需經法律程序隨時可取回本貨品或代物清償. ***";

fn write_form(title: &str, header: &Header, rows: &[Row], path: &str) -> Result<(), String> {
    let mut book = umya::new_file();
    let sheet = book.get_sheet_mut(&0).ok_or("找不到工作表")?;

    let widths = [
        ("A", 3.09), ("B", 10.55), ("C", 10.73), ("D", 9.36), ("E", 35.09), ("F", 11.09),
        ("G", 6.09), ("H", 32.36), ("I", 8.0), ("J", 8.82), ("K", 4.09), ("L", 8.09),
    ];
    for (col, w) in widths {
        sheet.get_column_dimension_mut(col).set_width(w);
    }
    let heights: [(u32, f64); 16] = [
        (1, 14.2), (2, 30.0), (3, 21.5), (4, 22.0), (5, 22.0), (6, 22.0), (7, 25.0),
        (8, 25.0), (9, 25.0), (10, 25.0), (11, 25.0), (12, 25.0), (13, 25.0),
        (14, 25.0), (15, 25.0), (16, 25.0),
    ];
    for (r, h) in heights {
        sheet.get_row_dimension_mut(&r).set_height(h);
    }

    // 第 2 列：客戶編號(左) / 寶號 22(中) / 我方地址 10(右)
    set_s(sheet, (2, 2), "客戶編號:");
    fontset(sheet, (2, 2), F_LABEL, 9.0);
    left_mid(sheet, (2, 2));
    sheet.add_merge_cells("B2:D2");
    set_s(sheet, (5, 2), &header.my_company);
    fontset(sheet, (5, 2), F_LABEL, 22.0);
    center(sheet, (5, 2));
    sheet.add_merge_cells("E2:G2");
    set_s(sheet, (8, 2), &header.my_address);
    fontset(sheet, (8, 2), F_LABEL, 10.0);
    right_mid(sheet, (8, 2));
    sheet.add_merge_cells("H2:J2");

    // 第 3 列：標題 16(中) / TEL FAX 10(右)
    set_s(sheet, (5, 3), title);
    fontset(sheet, (5, 3), F_LABEL, 16.0);
    center(sheet, (5, 3));
    sheet.add_merge_cells("E3:G3");
    set_s(sheet, (8, 3), &format!("TEL:{} FAX:{}", header.my_phone, header.my_fax));
    fontset(sheet, (8, 3), F_LABEL, 10.0);
    right_mid(sheet, (8, 3));
    sheet.add_merge_cells("H3:J3");

    // 抬頭區：左 客戶名稱/電話/地址，右 出貨日期/貨單編號/收訖摘要
    let addr_label = format!("{}:", ADDR_TYPES.iter().find(|t| **t == header.cust_addr_type).unwrap_or(&"客戶地址"));
    let labels: [(u32, u32, &str, &str, f64); 7] = [
        (2, 4, "客戶名稱:", F_LABEL, 12.0),
        (9, 4, "出貨日期:", F_DATE, 9.0),
        (2, 5, "電    話:", F_LABEL, 12.0),
        (9, 5, "貨單編號:", F_DATE, 9.0),
        (2, 6, addr_label.as_str(), F_LABEL, 12.0),
        (9, 6, "收訖摘要:", F_DATE, 9.0),
        (6, 6, "發票:", F_BODY, 12.0),
    ];
    for (c, r, t, font, sz) in labels {
        set_s(sheet, (c, r), t);
        fontset(sheet, (c, r), font, sz);
        if c == 6 { right_mid(sheet, (c, r)); } else { center(sheet, (c, r)); }
    }
    // 抬頭值
    let kv: [(u32, u32, String, &str, f64, bool); 5] = [
        (3, 4, header.cust_name.clone(), F_LABEL, 11.0, true),
        (10, 4, to_minguo(&header.order_date), F_DATE, 9.0, false),
        (3, 5, header.cust_phone.clone(), F_LABEL, 12.0, true),
        (10, 5, header.order_no.clone(), F_DATE, 9.0, false),
        (3, 6, header.cust_ship_addr.clone(), F_LABEL, 12.0, true),
    ];
    for (c, r, v, font, sz, merge) in kv {
        set_s(sheet, (c, r), &v);
        fontset(sheet, (c, r), font, sz);
        left_mid(sheet, (c, r));
        if merge {
            sheet.add_merge_cells(format!("C{r}:E{r}"));
        }
    }
    // 第 6 列底細線（抬頭與表格分隔）
    for c in 2..=10u32 {
        edge(sheet, (c, 6), "b", Border::BORDER_THIN);
    }

    // 表頭（第 7 列）
    set_s(sheet, (2, 7), "項目編號");
    set_s(sheet, (3, 7), "品  名  規  格");
    sheet.add_merge_cells("C7:E7");
    set_s(sheet, (6, 7), "數 量");
    set_s(sheet, (7, 7), "單 價");
    set_s(sheet, (8, 7), "小 計");
    set_s(sheet, (9, 7), "備 註");
    sheet.add_merge_cells("I7:J7");
    for c in 2..=10u32 {
        fontset(sheet, (c, 7), F_LABEL, 12.0);
        center(sheet, (c, 7));
    }
    border_range(sheet, 2, 7, 10, 7);

    // 明細：固定 7 列（第 8~14 列）
    // ponytail: 固定 7 列，超過 7 筆者不顯示——版面就是 7 列
    let mut amount = 0.0f64;
    for i in 0..7usize {
        let n = 8 + i as u32;
        fontset(sheet, (2, n), F_BODY, 12.0);
        center(sheet, (2, n));
        sheet.add_merge_cells(format!("C{n}:E{n}"));
        fontset(sheet, (3, n), F_BODY, 11.0);
        left_mid(sheet, (3, n));
        fontset(sheet, (6, n), F_KAI, 12.0);
        center(sheet, (6, n));
        fontset(sheet, (7, n), F_BODY, 12.0);
        center(sheet, (7, n));
        fontset(sheet, (8, n), F_BODY, 12.0);
        center(sheet, (8, n));
        if n > 12 {
            sheet.add_merge_cells(format!("I{n}:J{n}"));
        }
        fontset(sheet, (9, n), F_KAI, 12.0);
        left_mid(sheet, (9, n));
        if let Some(r) = rows.get(i) {
            let sub = r.qty * r.price;
            amount += sub;
            sheet.get_cell_mut((2u32, n)).set_value_number((i + 1) as f64);
            let size = if r.size.trim().is_empty() { String::new() } else { format!("{}{}", r.size, r.size_unit) };
            set_s(sheet, (3, n), &format!("{}{}", r.name, size));
            let qty = if r.unit.trim().is_empty() {
                num_int(r.qty)
            } else {
                format!("{}{}", num_int(r.qty), r.unit)
            };
            set_s(sheet, (6, n), &qty);
            sheet.get_cell_mut((7u32, n)).set_value_number(r.price);
            sheet.get_cell_mut((8u32, n)).set_value_number(sub);
        }
        border_range(sheet, 2, n, 10, n);
    }
    // 備註區塊（I8:J12 合併、自動換行）＋ 客戶簽收（第 13 列）
    sheet.add_merge_cells("I8:J12");
    set_s(sheet, (9, 8), &header.remark);
    center(sheet, (9, 8));
    sheet.get_cell_mut((9u32, 8u32)).get_style_mut().get_alignment_mut().set_wrap_text(true);
    set_s(sheet, (9, 13), "客戶簽收");
    center(sheet, (9, 13));
    // 末列（14）備註底中線
    edge(sheet, (9, 14), "b", Border::BORDER_MEDIUM);
    edge(sheet, (10, 14), "b", Border::BORDER_MEDIUM);

    // 合計列（第 15 列）：整單一次營業稅 5%
    let (tax_label, tax) = match header.tax_type.as_str() {
        "zero" => ("零稅率", 0.0),
        "exempt" => ("免稅", 0.0),
        _ => ("營業稅", (amount * 0.05).round()),
    };
    let total = amount + tax;
    for (c, t) in [(2u32, "經辦人"), (4, "銷貨總額"), (6, tax_label), (8, "總計")] {
        set_s(sheet, (c, 15), t);
    }
    set_s(sheet, (3, 15), &header.cust_sales);
    sheet.get_cell_mut((5u32, 15)).set_value_number(amount);
    sheet.get_cell_mut((7u32, 15)).set_value_number(tax);
    sheet.get_cell_mut((9u32, 15)).set_value_number(total);
    sheet.add_merge_cells("I15:J15");
    for c in 2..=10u32 {
        fontset(sheet, (c, 15), F_BODY, 12.0);
        center(sheet, (c, 15));
    }
    border_range(sheet, 2, 15, 10, 15);
    // 總計金額框加中線強調
    edge(sheet, (8, 15), "r", Border::BORDER_MEDIUM);
    edge(sheet, (9, 15), "t", Border::BORDER_MEDIUM);
    edge(sheet, (9, 15), "l", Border::BORDER_MEDIUM);
    edge(sheet, (10, 15), "t", Border::BORDER_MEDIUM);
    edge(sheet, (10, 15), "r", Border::BORDER_MEDIUM);

    // 法律聲明列（第 16 列，8pt，置中，細框）
    set_s(sheet, (2, 16), DISCLAIMER);
    fontset(sheet, (2, 16), F_BODY, 8.0);
    center(sheet, (2, 16));
    sheet.add_merge_cells("B16:J16");
    border_range(sheet, 2, 16, 10, 16);

    // 公司章：第 17 列 I 欄起，長邊縮到 120px 內並保持比例
    if !header.stamp.trim().is_empty() {
        let bytes = std::fs::read(&header.stamp).map_err(|e| format!("讀取公司章失敗：{e}"))?;
        let dim = imagesize::blob_size(&bytes).map_err(|e| format!("公司章圖檔格式不支援：{e}"))?;
        let k = (120.0 / dim.width.max(dim.height) as f64).min(1.0);
        let (w, h) = ((dim.width as f64 * k) as u32, (dim.height as f64 * k) as u32);
        let name = std::path::Path::new(&header.stamp)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("stamp.png");
        let mut marker = umya::structs::drawing::spreadsheet::MarkerType::default();
        marker.set_coordinate("I17");
        let mut img = umya::structs::Image::default();
        img.new_image_with_dimensions(h, w, name, bytes, marker);
        sheet.add_image(img);
    }

    umya::writer::xlsx::write(&book, std::path::Path::new(path))
        .map_err(|e| format!("寫檔失敗（檔案可能正開在 Excel 中）：{e:?}"))
}

// 讀回 Example 版面（0-based）：寶號 E2、地址 H2、TEL/FAX H3、客戶名稱 C4、日期 J4、
// 電話 C5、單號 J5、地址 C6、經辦人 C15、明細 第 8~14 列
#[tauri::command]
fn load_excel(path: String) -> Result<serde_json::Value, String> {
    let mut wb = open_workbook_auto(&path).map_err(|e| e.to_string())?;
    let range = wb
        .worksheet_range_at(0)
        .ok_or("檔案無工作表")?
        .map_err(|e| e.to_string())?;
    let data: Vec<&[Data]> = range.rows().collect();
    let g = |row: usize, col: usize| -> String {
        data.get(row).map(|r| cell(r, col)).unwrap_or_default()
    };

    let telfax = g(2, 7);
    let header = Header {
        my_company: g(1, 4).trim().to_string(),
        my_address: g(1, 7).trim().to_string(),
        my_phone: after_key(&telfax, "TEL:"),
        my_fax: after_key(&telfax, "FAX:"),
        cust_name: g(3, 2).trim().to_string(),
        cust_phone: g(4, 2).trim().to_string(),
        cust_ship_addr: g(5, 2).trim().to_string(),
        cust_sales: g(14, 2).trim().to_string(),
        order_no: g(4, 9).trim().to_string(),
        order_date: from_minguo(&g(3, 9)),
        cust_tax_id: String::new(),
        cust_contact: String::new(),
        doc_type: DOC_TYPES.iter().find(|t| **t == g(2, 4).trim()).unwrap_or(&"銷貨單").to_string(),
        cust_addr_type: ADDR_TYPES
            .iter()
            .find(|t| g(5, 1).trim().trim_end_matches(':').trim_end_matches('：') == **t)
            .unwrap_or(&"客戶地址")
            .to_string(),
        remark: g(7, 8).trim().to_string(),
        stamp: String::new(),
        tax_type: match g(14, 5).trim() {
            "零稅率" => "zero",
            "免稅" => "exempt",
            _ => "taxable",
        }
        .to_string(),
    };

    let mut rows: Vec<Row> = Vec::new();
    for idx in 7..=13usize {
        let name = g(idx, 2);
        if name.trim().is_empty() {
            continue;
        }
        let (qty, unit) = split_qty(&g(idx, 5));
        rows.push(Row { name, size: String::new(), size_unit: String::new(), unit, qty, price: num(data[idx], 6) });
    }

    Ok(serde_json::json!({ "header": header, "rows": rows }))
}

// 民國 yyy/mm/dd 轉西元 YYYY-MM-DD（input[type=date] 用）；非民國格式原樣回傳
fn from_minguo(s: &str) -> String {
    let p: Vec<&str> = s.split('/').collect();
    match (
        p.first().and_then(|y| y.trim().parse::<i32>().ok()),
        p.get(1).and_then(|m| m.trim().parse::<u32>().ok()),
        p.get(2).and_then(|d| d.trim().parse::<u32>().ok()),
    ) {
        (Some(y), Some(m), Some(d)) if y < 1911 => format!("{:04}-{:02}-{:02}", y + 1911, m, d),
        _ => s.trim().to_string(),
    }
}
// 從 "TEL:xxx FAX:yyy" 取 key 後第一段
fn after_key(s: &str, key: &str) -> String {
    s.split(key)
        .nth(1)
        .and_then(|x| x.split_whitespace().next())
        .unwrap_or("")
        .to_string()
}
// "1面" → (1.0, "面")；數字在前、單位在後
fn split_qty(s: &str) -> (f64, String) {
    let n: String = s.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let unit = s[n.len()..].trim().to_string();
    (n.parse().unwrap_or(0.0), unit)
}

// ---- 樣式輔助 ----
fn set_s(sheet: &mut umya::Worksheet, coord: (u32, u32), v: &str) {
    sheet.get_cell_mut(coord).set_value_string(v);
}
fn thin_border(sheet: &mut umya::Worksheet, coord: (u32, u32)) {
    let b = sheet.get_cell_mut(coord).get_style_mut().get_borders_mut();
    black_side(b.get_top_mut(), Border::BORDER_THIN);
    black_side(b.get_bottom_mut(), Border::BORDER_THIN);
    black_side(b.get_left_mut(), Border::BORDER_THIN);
    black_side(b.get_right_mut(), Border::BORDER_THIN);
}
fn border_range(sheet: &mut umya::Worksheet, c1: u32, r1: u32, c2: u32, r2: u32) {
    for col in c1..=c2 {
        for row in r1..=r2 {
            thin_border(sheet, (col, row));
        }
    }
}
fn align(sheet: &mut umya::Worksheet, coord: (u32, u32), h: HA, v: VA) {
    let a = sheet.get_cell_mut(coord).get_style_mut().get_alignment_mut();
    a.set_horizontal(h);
    a.set_vertical(v);
}
fn left_mid(sheet: &mut umya::Worksheet, coord: (u32, u32)) {
    align(sheet, coord, HA::Left, VA::Center);
}
fn right_mid(sheet: &mut umya::Worksheet, coord: (u32, u32)) {
    align(sheet, coord, HA::Right, VA::Center);
}
fn center(sheet: &mut umya::Worksheet, coord: (u32, u32)) {
    align(sheet, coord, HA::Center, VA::Center);
}
fn cell(r: &[Data], i: usize) -> String {
    r.get(i).map(|c| c.to_string()).unwrap_or_default()
}
fn num(r: &[Data], i: usize) -> f64 {
    r.get(i).and_then(|c| c.as_f64()).unwrap_or(0.0)
}

#[tauri::command]
fn append_history(app: tauri::AppHandle, file: String, path: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    create_dir_all(&dir).map_err(|e| e.to_string())?;
    let time = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let line = serde_json::json!({ "file": file, "path": path, "time": time }).to_string();
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("history.jsonl"))
        .map_err(|e| e.to_string())?;
    writeln!(f, "{}", line).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_history(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let log = dir.join("history.jsonl");
    if !log.exists() {
        return Ok(vec![]);
    }
    let f = File::open(log).map_err(|e| e.to_string())?;
    let mut out: Vec<serde_json::Value> = BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect();
    out.reverse();
    Ok(out)
}

// 回傳原始位元組給前端（公司章預覽／列印）
#[tauri::command]
fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    open::that(path).map_err(|e| e.to_string())
}

// 掃資料夾內 "{label}_{prefix}NNN.xlsx"，回傳最小未使用流水號（補空號、依類型分開）
#[tauri::command]
fn next_seq(dir: String, label: String, prefix: String) -> u32 {
    let head = format!("{label}_{prefix}");
    let mut used = std::collections::HashSet::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(rest) = name.strip_prefix(&head) {
                // 檔名：{類型}_{日期}{3位流水號}[-客戶註記].xlsx
                if let Some(stem) = rest.strip_suffix(".xlsx") {
                    let digits: String = stem.chars().take(3).collect();
                    let tail = &stem[digits.len()..];
                    if digits.len() == 3 && (tail.is_empty() || tail.starts_with('-')) {
                        if let Ok(n) = digits.parse::<u32>() {
                            used.insert(n);
                        }
                    }
                }
            }
        }
    }
    let mut n = 1;
    while used.contains(&n) {
        n += 1;
    }
    n
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_form,
            load_excel,
            next_seq,
            append_history,
            read_history,
            read_file,
            open_file
        ])
        .run(tauri::generate_context!())
        .expect("啟動失敗");
}
