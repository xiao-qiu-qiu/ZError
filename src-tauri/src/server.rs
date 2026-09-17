use crate::app_activity::{begin_server_activity, end_server_activity};
use crate::answer_validation::{parse_model_answer, validate_and_normalize_answer};
use crate::database::{
    get_ai_response_by_id, insert_ai_response, query_database_candidates, query_database_exact,
    set_question_pending_correction, QuestionMatch,
};
use crate::types::{
    ModelCallProgressRequest, ModelCallResponseRequest, QueryData, QueryRequest, QueryResponse,
    ServerInfo, ServerState,
};
use futures_util::StreamExt;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};
use tokio_stream::wrappers::BroadcastStream;
use uuid;
use warp::http::{HeaderMap, StatusCode};
use warp::Filter;

const QUERY_TEST_PAGE_HTML: &str = include_str!("query_test_page.html");

fn read_app_config() -> serde_json::Value {
    let config_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("config.json");
    std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 是否将 AI 回答写入本地题库（读取 config.json 的 autoAddToQuestionBank）
fn should_auto_add_to_question_bank() -> bool {
    read_app_config()
        .get("autoAddToQuestionBank")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// 从设置计算模型等待预算：(静默超时秒, 绝对上限秒)
/// - inactivity：无新进度多久判超时（≈ 单次最长响应 + 余量）
/// - absolute：整段等待硬上限（覆盖重试，且不受 keepalive 续命）
fn model_wait_budget_secs(has_url: bool) -> (u64, u64) {
    let cfg = read_app_config();
    let timeout = cfg
        .get("modelResponseTimeout")
        .and_then(|v| v.as_u64())
        .unwrap_or(40)
        .clamp(5, 600);
    let retries = cfg
        .get("modelRetryCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(2)
        .min(10);
    let search = &cfg["search"];
    if search["mode"].as_str().unwrap_or("auto") != "off" {
        let budget = search["timeoutSeconds"].as_u64().unwrap_or(120).clamp(30, 600);
        // Frontend deadline covers inference, tools, retries and arbitration.
        // This small transport grace permits returning a review result at expiry.
        return (timeout.saturating_add(20).max(30), budget.saturating_add(10));
    }
    let inactivity = timeout.saturating_add(20).max(30);
    let absolute = timeout
        .saturating_mul(retries + 1)
        .saturating_add(if has_url { 90 } else { 60 })
        .max(inactivity);
    (inactivity, absolute)
}

/// 验证管理员 token（从 Authorization: Bearer <token> 或直接值中提取）
fn check_admin_token(auth: &Option<String>) -> bool {
    let token = match auth {
        None => return false,
        Some(v) => {
            let v = v.trim();
            if v.to_lowercase().starts_with("bearer ") {
                v[7..].trim().to_string()
            } else {
                v.to_string()
            }
        }
    };
    if token.is_empty() {
        return false;
    }
    let config = read_app_config();
    let admin_token = config
        .get("adminToken")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    !admin_token.is_empty() && token == admin_token
}

/// 检测文本中是否包含URL
fn contains_url(text: &str) -> bool {
    let url_regex = Regex::new(r"https?://[^\s]+").unwrap();
    url_regex.is_match(text)
}

fn resolve_request_origin(headers: &HeaderMap) -> String {
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("127.0.0.1:3000");
    format!("http://{}", host)
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn build_pending_correction_button(origin: &str, question_id: i64, is_pending_correction: bool) -> String {
    if question_id <= 0 {
        return String::new();
    }

    if is_pending_correction {
        return "<button type=\"button\" disabled style=\"padding:4px 10px;border:none;border-radius:999px;background:#f59e0b;color:#fff;font-size:12px;cursor:not-allowed;opacity:0.75;white-space:nowrap;\">已标记待修正</button>".to_string();
    }

    let url = format!("{}/api/questions/{}/pending-correction", origin, question_id);
    format!(
        r#"<button type="button" style="padding:4px 10px;border:none;border-radius:999px;background:#ef4444;color:#fff;font-size:12px;cursor:pointer;white-space:nowrap;" onclick="(async()=>{{const btn=this;if(btn.dataset.loading==='1')return;const text=btn.textContent||'标记为待修正';btn.dataset.loading='1';btn.disabled=true;btn.textContent='标记中...';try{{const res=await fetch('{url}',{{method:'POST'}});const data=await res.json().catch(()=>({{success:false,message:'标记失败'}}));if(!res.ok||!data.success)throw new Error(data.message||'标记失败');btn.textContent='已标记待修正';btn.style.opacity='0.75';btn.style.cursor='not-allowed';}}catch(error){{btn.disabled=false;btn.textContent=text;alert(error&&error.message?error.message:'标记失败');}}finally{{delete btn.dataset.loading;}}}})()">标记为待修正</button>"#,
        url = url
    )
}

fn build_query_data(
    origin: &str,
    question_id: i64,
    question: &str,
    answer: String,
    is_ai: bool,
    is_pending_correction: bool,
) -> QueryData {
    let escaped_question = escape_html(question).replace('\n', "<br>");
    let button_html = build_pending_correction_button(origin, question_id, is_pending_correction);
    let question_html = if button_html.is_empty() {
        escaped_question
    } else {
        format!(
            "<div style=\"display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;\"><span style=\"flex:1 1 auto;min-width:0;\">{}</span>{}</div>",
            escaped_question, button_html
        )
    };

    QueryData {
        id: question_id,
        question: question_html,
        answer,
        is_ai,
        is_pending_correction,
        search_evidence: None,
    }
}

#[derive(Debug, Clone, Copy)]
enum QuestionKind {
    Single,
    Multiple,
    Judgement,
    Completion,
}

impl QuestionKind {
    fn chinese_name(&self) -> &'static str {
        match self {
            QuestionKind::Single => "单选",
            QuestionKind::Multiple => "多选",
            QuestionKind::Judgement => "判断",
            QuestionKind::Completion => "填空",
        }
    }

    fn prompt_hint(&self) -> &'static str {
        match self {
            QuestionKind::Single => {
                "这是单选题，只有一个正确答案。answer 只能写正确选项的完整文字（与【选项】原文一致），禁止写 A/B/C/D，也禁止写成「B. 4」这种带字母前缀的形式，应直接写「4」。"
            }
            QuestionKind::Multiple => {
                "这是多选题，可能有多个正确答案。answer 只写各正确选项的完整文字，用 ### 连接（顺序不限）。禁止写 ABD，禁止写「A. xxx###C. yyy」这种带字母前缀的形式。"
            }
            QuestionKind::Judgement => {
                "这是判断题。answer 只能是「正确」或「错误」二字之一。禁止写 A/B，禁止写「A. 正确」。"
            }
            QuestionKind::Completion => {
                "这是填空题。answer 只填空白处应填的内容本身；若有多个空，用 ### 连接。不要加第1空/①/A. 等序号前缀。"
            }
        }
    }

    /// 题型对应的典型对答示例（写入 prompt；前端也会以多轮对话注入）
    fn few_shot_block(&self) -> &'static str {
        match self {
            QuestionKind::Single => {
                "【作答示例】\n\
题目：以下哪个整数是偶数？\n\
选项：A. 3  B. 4  C. 5\n\
正确输出：{\"answer\": \"4\"}\n\
错误输出：{\"answer\": \"B. 4\"} 或 {\"answer\": \"B\"}\n"
            }
            QuestionKind::Multiple => {
                "【作答示例】\n\
题目：下列属于输入设备的有（ ）。\n\
选项：A. 键盘  B. 显示器  C. 鼠标  D. 打印机\n\
正确输出：{\"answer\": \"键盘###鼠标\"}\n\
错误输出：{\"answer\": \"AC\"} 或 {\"answer\": \"A. 键盘###C. 鼠标\"}\n"
            }
            QuestionKind::Judgement => {
                "【作答示例】\n\
题目：地球绕太阳公转一周约为 365 天。\n\
正确输出：{\"answer\": \"正确\"}\n\
错误输出：{\"answer\": \"A\"} 或 {\"answer\": \"A. 正确\"}\n"
            }
            QuestionKind::Completion => {
                "【作答示例】\n\
题目：十进制中，1+1=____，2+2=____。\n\
正确输出：{\"answer\": \"2###4\"}\n\
错误输出：{\"answer\": \"第1空：2###第2空：4\"}\n"
            }
        }
    }
}

fn detect_question_kind(query_type: &str) -> Option<QuestionKind> {
    let trimmed = query_type.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = trimmed.to_lowercase();

    if normalized.contains("single") || trimmed.contains("单选") || trimmed.contains("单项选择")
    {
        Some(QuestionKind::Single)
    } else if normalized.contains("multiple")
        || trimmed.contains("多选")
        || trimmed.contains("多项选择")
    {
        Some(QuestionKind::Multiple)
    } else if normalized.contains("judgement")
        || normalized.contains("judgment")
        || trimmed.contains("判断")
    {
        Some(QuestionKind::Judgement)
    } else if normalized.contains("completion") || trimmed.contains("填空") {
        Some(QuestionKind::Completion)
    } else {
        None
    }
}

fn build_model_query_prompt(
    title: &str,
    options: Option<&str>,
    query_type: Option<&str>,
) -> String {
    let mut q = String::from(
        "你是一个专业的答题助手。请按以下要求作答：\n"
    );

    q.push_str("1. 先在内部完成审题与推理（可简要），再给出最终答案。\n");
    q.push_str("2. 最后一行输出**唯一**一个 JSON 对象，不要用 markdown 代码块包裹，JSON 前后不要附加说明。\n");
    q.push_str("3. JSON 格式严格为：{\"answer\": \"最终答案\"}；仅当确实无法确定时可增加 \"needs_review\": true。\n");
    q.push_str("4. answer 只写答案正文本身：选择题必须与【选项】中去掉「A.」「B.」后的文字完全一致；判断题只写「正确」或「错误」；填空题只写填空内容。\n");
    q.push_str("5. 严禁把选项字母写进 answer：不要写 A/B/C/D，不要写「B. 4」「D. meeting」，应直接写「4」「meeting」。不要把分析过程写进 answer。\n\n");

    if let Some(raw_type) = query_type.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(kind) = detect_question_kind(raw_type) {
            q.push_str(&format!("【题目类型：{}题】\n", kind.chinese_name()));
            q.push_str(&format!("提示：{}\n", kind.prompt_hint()));
            q.push_str(kind.few_shot_block());
            q.push('\n');
        } else {
            q.push_str(&format!("【题目类型字段：{}】\n", raw_type));
        }
    }

    q.push_str(&format!("【题目】\n{}\n", title));

    if let Some(options) = options.map(str::trim).filter(|value| !value.is_empty()) {
        q.push_str(&format!("【选项】\n{}\n", options));
    }

    q.push_str("\n请作答，并在最后输出答案 JSON：");

    q
}

const SAME_QUESTION_CHECK_PREFIX: &str = "__SAME_QUESTION_CHECK__:";
const SAME_QUESTION_CANDIDATE_LIMIT: usize = 5;
const SAME_QUESTION_CANDIDATE_SCAN_LIMIT: usize = 20;

fn build_same_question_check_prompt(title: &str, options: Option<&str>, candidates: &[QuestionMatch]) -> String {
    let candidate_list: Vec<serde_json::Value> = candidates
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "question": c.question,
                "options": c.options,
            })
        })
        .collect();

    let payload = serde_json::json!({
        "title": title,
        "options": options,
        "candidates": candidate_list,
    });

    format!(
        "{}{}",
        SAME_QUESTION_CHECK_PREFIX,
        serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())
    )
}

fn parse_same_question_result(content: &str) -> Option<i64> {
    let trimmed = content.trim();
    if trimmed.is_empty() || is_model_error(trimmed).is_some() {
        return None;
    }

    let json_str = if let Some(start) = trimmed.find('{') {
        let end = trimmed.rfind('}').unwrap_or(trimmed.len() - 1);
        &trimmed[start..=end]
    } else {
        trimmed
    };

    let value: Value = serde_json::from_str(json_str).ok()?;
    let same = value.get("same").and_then(|v| v.as_bool()).unwrap_or(false);
    if !same {
        return None;
    }
    value
        .get("matched_id")
        .and_then(|v| v.as_i64())
        .or_else(|| {
            value
                .get("matched_id")
                .and_then(|v| v.as_u64())
                .map(|v| v as i64)
        })
}

fn build_normal_model_query(request: &QueryRequest, has_url: bool) -> String {
    if has_url {
        let mut q = format!("__URL_QUESTION__:{}", request.title);
        if let Some(options) = &request.options {
            if !options.is_empty() {
                q.push_str(&format!("\n__OPTIONS__:{}", options));
            }
        }
        q
    } else {
        build_model_query_prompt(
            &request.title,
            request.options.as_deref(),
            request.query_type.as_deref(),
        )
    }
}

fn answer_review_error(reason: impl AsRef<str>) -> (u16, QueryResponse) {
    (
        422,
        QueryResponse::error(format!("答案待复核：{}", reason.as_ref())),
    )
}

fn query_http_reply(
    status: u16,
    response: &QueryResponse,
) -> warp::reply::WithStatus<warp::reply::Json> {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    warp::reply::with_status(warp::reply::json(response), status)
}

fn validate_cached_answer(request: &QueryRequest, matched: &QuestionMatch) -> Result<String, String> {
    let request_question_type = request
        .query_type
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let cached_question_type = matched
        .question_type
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or(request_question_type);
    let decoded_answer = validate_and_normalize_answer(
        &matched.answer,
        &matched.question,
        matched.options.as_deref(),
        cached_question_type,
    )?;
    let request_options = request
        .options
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or(matched.options.as_deref());
    let request_question_type = request_question_type
        .or(matched.question_type.as_deref());
    validate_and_normalize_answer(
        &decoded_answer,
        &request.title,
        request_options,
        request_question_type,
    )
}

fn exact_answers_conflict(data_list: &[QueryData]) -> bool {
    let Some(first) = data_list.first() else {
        return false;
    };
    data_list
        .iter()
        .skip(1)
        .any(|item| item.answer != first.answer)
}

fn emit_model_call_request(app: Option<&AppHandle>, request_id: &str, query: &str) {
    if let Some(app) = app {
        let payload = serde_json::json!({
            "request_id": request_id,
            "query": query,
        });
        if let Err(e) = app.emit("model-call-request", payload) {
            println!("⚠️ emit model-call-request failed: {}", e);
        } else {
            println!("📣 Emitted model-call-request via Tauri event");
        }
    }
}

async fn wait_and_store_ai_answer(
    logger: &crate::logger::RequestLogger,
    app: Option<&AppHandle>,
    request: &QueryRequest,
    request_id: &str,
    request_origin: &str,
    has_url: bool,
) -> (u16, QueryResponse) {
    let formatted_query = build_normal_model_query(request, has_url);
    logger.send_model_call_request(request_id.to_string(), formatted_query.clone());
    emit_model_call_request(app, request_id, &formatted_query);

    // 覆盖前端超时 × 重试；absolute 防止 keepalive 无限续命
    let (inactivity_secs, absolute_secs) = model_wait_budget_secs(has_url);
    println!(
        "⏳ model wait budget: inactivity={}s absolute={}s (has_url={})",
        inactivity_secs, absolute_secs, has_url
    );
    match logger
        .wait_for_model_response(request_id.to_string(), inactivity_secs, absolute_secs)
        .await
    {
        Ok(model_content) => {
            println!("✅ Received model response: {}", model_content);
            if let Some((status, err_msg)) = classify_model_failure(&model_content) {
                return (status, QueryResponse::error(err_msg));
            }

            let parsed_answer = match parse_model_answer(&model_content) {
                Ok(parsed) => parsed,
                Err(reason) => {
                    println!("⚠️ 模型答案 JSON 校验失败: {}", reason);
                    return answer_review_error(reason);
                }
            };
            if parsed_answer.needs_review {
                println!("⚠️ 模型将答案标记为 needs_review");
                return answer_review_error("模型标记该答案需要复核");
            }

            let extracted_answer = match validate_and_normalize_answer(
                &parsed_answer.answer,
                &request.title,
                request.options.as_deref(),
                request.query_type.as_deref(),
            ) {
                Ok(answer) => answer,
                Err(reason) => {
                    println!("⚠️ 模型答案内容校验失败: {}", reason);
                    return answer_review_error(reason);
                }
            };

            let inserted_id = if !should_auto_add_to_question_bank() {
                println!("ℹ️ autoAddToQuestionBank=false，跳过将 AI 回答写入本地题库");
                0
            } else {
                match insert_ai_response(
                    &request.title,
                    &extracted_answer,
                    request.options.clone(),
                    request.query_type.clone(),
                    true,
                ) {
                    Ok(id) => {
                        println!("✅ AI response stored to database");
                        id
                    }
                    Err(e) => {
                        println!("❌ Failed to store AI response: {}", e);
                        0
                    }
                }
            };

            let mut data = build_query_data(
                request_origin,
                inserted_id,
                &request.title,
                extracted_answer,
                true,
                false,
            );
            data.search_evidence = serde_json::from_str::<Value>(&model_content)
                .ok().and_then(|v| v.get("_search").cloned());
            (200, QueryResponse::success(vec![data]))
        }
        Err(e) => {
            println!("❌ Model call timeout or error: {}", e);
            (
                408,
                QueryResponse::error(format!("Model call failed: {}", e)),
            )
        }
    }
}

async fn resolve_query_with_same_question_check(
    logger: &crate::logger::RequestLogger,
    app: Option<&AppHandle>,
    request: &QueryRequest,
    request_id: &str,
    request_origin: &str,
) -> (u16, QueryResponse) {
    let mut has_url = contains_url(&request.title);
    if let Some(options) = &request.options {
        if !has_url {
            has_url = contains_url(options);
        }
    }

    // 1) 精确命中直接返回
    match query_database_exact(&request.title, request.options.as_deref()).await {
        Ok(exact_hits) => {
            let hit_count = exact_hits.len();
            let data_list: Vec<QueryData> = exact_hits
                .into_iter()
                .filter_map(|matched| match validate_cached_answer(request, &matched) {
                    Ok(answer) => Some(build_query_data(
                        request_origin,
                        matched.id,
                        &matched.question,
                        answer,
                        matched.is_ai,
                        false,
                    )),
                    Err(reason) => {
                        println!(
                            "⚠️ 跳过无效精确缓存 id={}: {}",
                            matched.id, reason
                        );
                        None
                    }
                })
                .collect();
            if !data_list.is_empty() {
                println!("✅ 精确匹配有效命中: {}/{} 条", data_list.len(), hit_count);
                if exact_answers_conflict(&data_list) {
                    println!("⚠️ 精确匹配答案存在冲突，转入正常 AI 答题");
                    return wait_and_store_ai_answer(
                        logger,
                        app,
                        request,
                        request_id,
                        request_origin,
                        has_url,
                    )
                    .await;
                } else {
                    return (200, QueryResponse::success(data_list));
                }
            } else {
                println!("🔍 无有效精确匹配: {}", request.title);
            }
        }
        Err(e) => {
            eprintln!("Database exact query error: {}", e);
            return (
                500,
                QueryResponse::error(format!("Database error: {}", e)),
            );
        }
    }

    // 2) 模糊候选 → AI 同题判断
    let candidates = match query_database_candidates(
        &request.title,
        request.options.as_deref(),
        SAME_QUESTION_CANDIDATE_SCAN_LIMIT,
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Database candidate query error: {}", e);
            return (
                500,
                QueryResponse::error(format!("Database error: {}", e)),
            );
        }
    }
    .into_iter()
    .filter_map(|mut matched| match validate_cached_answer(request, &matched) {
        Ok(answer) => {
            matched.answer = answer;
            Some(matched)
        }
        Err(reason) => {
            println!("⚠️ 跳过无效模糊缓存 id={}: {}", matched.id, reason);
            None
        }
    })
    .take(SAME_QUESTION_CANDIDATE_LIMIT)
    .collect::<Vec<_>>();

    if !candidates.is_empty() {
        println!(
            "🤖 发现 {} 条近似候选，请求 AI 同题判断",
            candidates.len()
        );
        let check_prompt =
            build_same_question_check_prompt(&request.title, request.options.as_deref(), &candidates);
        logger.send_model_call_request(request_id.to_string(), check_prompt.clone());
        emit_model_call_request(app, request_id, &check_prompt);

        match logger
            .wait_for_model_response(request_id.to_string(), 30, 45)
            .await
        {
            Ok(judge_content) => {
                println!("✅ 同题判断结果: {}", judge_content);
                // 未选择模型等客户端错误：直接返回，避免再回落正常答题又等一轮
                if let Some((status, err_msg)) = classify_model_failure(&judge_content) {
                    if status == 400 && err_msg.contains("未选择模型") {
                        return (status, QueryResponse::error(err_msg));
                    }
                }
                if let Some(matched_id) = parse_same_question_result(&judge_content) {
                    if let Some(matched) = candidates.iter().find(|c| c.id == matched_id).cloned() {
                        let answer = matched.answer.clone();
                        let response_id = if should_auto_add_to_question_bank() {
                            match insert_ai_response(
                                &request.title,
                                &answer,
                                request.options.clone(),
                                request.query_type.clone(),
                                matched.is_ai,
                            ) {
                                Ok(id) => {
                                    println!(
                                        "✅ 同题变体已入库, matched_id={}, new_id={}",
                                        matched_id, id
                                    );
                                    id
                                }
                                Err(e) => {
                                    println!("❌ 同题变体入库失败: {}，仍返回已有答案", e);
                                    matched.id
                                }
                            }
                        } else {
                            println!(
                                "ℹ️ autoAddToQuestionBank=false，同题命中不入库，直接返回 matched_id={}",
                                matched_id
                            );
                            matched.id
                        };

                        let data = build_query_data(
                            request_origin,
                            response_id,
                            &request.title,
                            answer,
                            matched.is_ai,
                            false,
                        );
                        return (200, QueryResponse::success(vec![data]));
                    }

                    // matched_id 不在候选中，尝试按 id 查库
                    if let Ok(matched) = get_ai_response_by_id(matched_id) {
                        let answer = match validate_cached_answer(request, &matched) {
                            Ok(answer) => answer,
                            Err(reason) => {
                                println!(
                                    "⚠️ 同题判断命中的缓存 id={} 无效: {}，回落正常答题",
                                    matched_id, reason
                                );
                                return wait_and_store_ai_answer(
                                    logger,
                                    app,
                                    request,
                                    request_id,
                                    request_origin,
                                    has_url,
                                )
                                .await;
                            }
                        };
                        let response_id = if should_auto_add_to_question_bank() {
                            match insert_ai_response(
                                &request.title,
                                &answer,
                                request.options.clone(),
                                request.query_type.clone(),
                                matched.is_ai,
                            ) {
                                Ok(id) => id,
                                Err(_) => matched.id,
                            }
                        } else {
                            matched.id
                        };
                        let data = build_query_data(
                            request_origin,
                            response_id,
                            &request.title,
                            answer,
                            matched.is_ai,
                            false,
                        );
                        return (200, QueryResponse::success(vec![data]));
                    }

                    println!(
                        "⚠️ 同题判断返回的 matched_id={} 无效，回落正常答题",
                        matched_id
                    );
                } else {
                    println!("ℹ️ AI 判定为不同题或解析失败，回落正常答题");
                }
            }
            Err(e) => {
                println!("⚠️ 同题判断超时/失败: {}，回落正常答题", e);
            }
        }
    } else {
        println!("🔍 无近似候选，直接走正常 AI 答题");
    }

    // 3) 正常 AI 答题
    wait_and_store_ai_answer(logger, app, request, request_id, request_origin, has_url).await
}

/// 启动HTTP服务器
#[tauri::command]
pub async fn start_server(
    port: u16,
    bind_address: String,
    state: State<'_, ServerState>,
) -> Result<ServerInfo, String> {
    // 验证端口号
    if port == 0 {
        return Err("Invalid port number".to_string());
    }

    // 检查服务器是否已经在运行
    {
        let info = state.info.lock();
        if info.running {
            return Ok(info.clone());
        }
    }

    // 克隆状态以在异步任务中使用
    let logger = state.logger.clone();

    // 创建请求记录中间件（用于其他路由）
    let logging_middleware = warp::log::custom(move |info| {
        let method = info.method().to_string();
        let path = info.path().to_string();
        let status = info.status().as_u16();
        let response_time = info.elapsed().as_millis() as u64;

        println!(
            "🔍 Logging middleware triggered: {} {} - Status: {}, Time: {}ms",
            method, path, status, response_time
        );

        // 对于非query路由,使用简化的日志记录
        logger.log_request(
            method,
            path,
            status,
            response_time,
            None, // request_body
            None, // response_body
            None, // headers
            None, // ip
            None, // user_agent
        );

        println!("✅ Request logged successfully");
    });

    // 状态路由
    let status_route = warp::path("api")
        .and(warp::path("status"))
        .and(warp::get())
        .map(|| {
            warp::reply::json(&serde_json::json!({
                "status": "running",
                "message": "Server is running"
            }))
        });

    // 时间路由
    let time_route = warp::path("api")
        .and(warp::path("time"))
        .and(warp::get())
        .map(|| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            warp::reply::json(&serde_json::json!({
                "timestamp": now,
                "time": chrono::Utc::now().to_rfc3339()
            }))
        });

    // Echo路由
    let echo_route = warp::path("api")
        .and(warp::path("echo"))
        .and(warp::post())
        .and(warp::body::json())
        .map(|body: serde_json::Value| {
            warp::reply::json(&serde_json::json!({
                "echo": body,
                "received_at": chrono::Utc::now().to_rfc3339()
            }))
        });

    // 数据库查询路由 - 带有详细日志记录
    let logger_for_query = state.logger.clone();
    let app_for_query = state.app_handle.clone();

    // POST 请求处理
    let query_post_route = warp::path("query")
        .and(warp::post())
        .and(warp::header::headers_cloned())
        .and(warp::body::json())
        .and_then(move |headers: HeaderMap, request: QueryRequest| {
            let logger = logger_for_query.clone();
            let app = app_for_query.clone();
            async move {
                let start_time = std::time::Instant::now();
                let request_body = serde_json::to_string(&request).unwrap_or_default();
                
                // 生成唯一请求ID
                let request_id = uuid::Uuid::new_v4().to_string();
                
                // 提取请求头信息
                let mut header_map = HashMap::new();
                for (key, value) in headers.iter() {
                    if let Ok(value_str) = value.to_str() {
                        header_map.insert(key.to_string(), value_str.to_string());
                    }
                }
                
                // 提取IP和User-Agent
                let user_agent = headers.get("user-agent")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let ip = headers.get("x-forwarded-for")
                    .or_else(|| headers.get("x-real-ip"))
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "127.0.0.1".to_string());

                // 记录请求开始
                logger.log_request_start(
                    request_id.clone(),
                    "POST".to_string(),
                    "/query".to_string(),
                    Some(request_body),
                    Some(header_map),
                    Some(ip),
                    user_agent,
                );

                let request_origin = resolve_request_origin(&headers);

                // 独立任务执行：请求端断开时仍会写完 completed 日志，避免 UI 一直「处理中」
                let logger_task = logger.clone();
                let app_task = app.clone();
                let request_task = request;
                let request_id_task = request_id.clone();
                let request_origin_task = request_origin;
                let join = tokio::spawn(async move {
                    let result = resolve_query_with_same_question_check(
                        &logger_task,
                        app_task.as_ref(),
                        &request_task,
                        &request_id_task,
                        &request_origin_task,
                    )
                    .await;
                    let response_time = start_time.elapsed().as_millis() as u64;
                    let response_body = serde_json::to_string(&result.1).unwrap_or_default();
                    if let Some(app) = app_task.as_ref() {
                        let _ = app.emit(
                            "request-log-complete",
                            serde_json::json!({
                                "id": request_id_task,
                                "status": result.0,
                                "response_time": response_time,
                                "stage": "completed",
                                "path": "/query",
                                "method": "POST",
                                "response_body": response_body,
                            }),
                        );
                    }
                    logger_task.log_request_complete(
                        request_id_task,
                        "POST".to_string(),
                        "/query".to_string(),
                        result.0,
                        response_time,
                        Some(serde_json::to_string(&result.1).unwrap_or_default()),
                    );
                    result
                });

                match join.await {
                    Ok(result) => Ok::<_, warp::Rejection>(query_http_reply(result.0, &result.1)),
                    Err(e) => {
                        eprintln!("❌ /query POST task join error: {}", e);
                        Ok(query_http_reply(
                            500,
                            &QueryResponse::error("Internal query task failed".to_string()),
                        ))
                    }
                }
            }
        });

    // GET 请求处理
    let logger_for_query_get = state.logger.clone();
    let app_for_query_get = state.app_handle.clone();
    let query_get_route = warp::path("query")
        .and(warp::get())
        .and(warp::header::headers_cloned())
        .and(warp::query::<HashMap<String, String>>())
        .and_then(move |headers: HeaderMap, params: HashMap<String, String>| {
            let logger = logger_for_query_get.clone();
            let app = app_for_query_get.clone();
            async move {
                let start_time = std::time::Instant::now();
                
                // 从查询参数构建 QueryRequest
                let title = params.get("title").cloned().unwrap_or_default();
                let options = params.get("options").cloned();
                let query_type = params.get("type").cloned();
                
                let request = QueryRequest {
                    title: title.clone(),
                    options,
                    query_type,
                };
                
                let request_body = serde_json::to_string(&request).unwrap_or_default();
                
                // 生成唯一请求ID
                let request_id = uuid::Uuid::new_v4().to_string();
                
                // 提取请求头信息
                let mut header_map = HashMap::new();
                for (key, value) in headers.iter() {
                    if let Ok(value_str) = value.to_str() {
                        header_map.insert(key.to_string(), value_str.to_string());
                    }
                }
                
                // 提取IP和User-Agent
                let user_agent = headers.get("user-agent")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let ip = headers.get("x-forwarded-for")
                    .or_else(|| headers.get("x-real-ip"))
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "127.0.0.1".to_string());

                // 记录请求开始
                logger.log_request_start(
                    request_id.clone(),
                    "GET".to_string(),
                    "/query".to_string(),
                    Some(request_body),
                    Some(header_map),
                    Some(ip),
                    user_agent,
                );

                let request_origin = resolve_request_origin(&headers);

                let logger_task = logger.clone();
                let app_task = app.clone();
                let request_task = request;
                let request_id_task = request_id.clone();
                let request_origin_task = request_origin;
                let join = tokio::spawn(async move {
                    let result = resolve_query_with_same_question_check(
                        &logger_task,
                        app_task.as_ref(),
                        &request_task,
                        &request_id_task,
                        &request_origin_task,
                    )
                    .await;
                    let response_time = start_time.elapsed().as_millis() as u64;
                    let response_body = serde_json::to_string(&result.1).unwrap_or_default();
                    if let Some(app) = app_task.as_ref() {
                        let _ = app.emit(
                            "request-log-complete",
                            serde_json::json!({
                                "id": request_id_task,
                                "status": result.0,
                                "response_time": response_time,
                                "stage": "completed",
                                "path": "/query",
                                "method": "GET",
                                "response_body": response_body,
                            }),
                        );
                    }
                    logger_task.log_request_complete(
                        request_id_task,
                        "GET".to_string(),
                        "/query".to_string(),
                        result.0,
                        response_time,
                        Some(serde_json::to_string(&result.1).unwrap_or_default()),
                    );
                    result
                });

                match join.await {
                    Ok(result) => Ok::<_, warp::Rejection>(query_http_reply(result.0, &result.1)),
                    Err(e) => {
                        eprintln!("❌ /query GET task join error: {}", e);
                        Ok(query_http_reply(
                            500,
                            &QueryResponse::error("Internal query task failed".to_string()),
                        ))
                    }
                }
            }
        });

    // 合并 GET 和 POST 路由
    let query_route = query_post_route.or(query_get_route);

    let mark_pending_correction_route = warp::path("api")
        .and(warp::path("questions"))
        .and(warp::path::param::<i64>())
        .and(warp::path("pending-correction"))
        .and(warp::post())
        .and_then(|question_id: i64| async move {
            match set_question_pending_correction(question_id, true).await {
                Ok(_) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({
                        "success": true,
                        "message": "题目已标记为待修正",
                        "id": question_id,
                    })),
                    warp::http::StatusCode::OK,
                )),
                Err(error) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({
                        "success": false,
                        "message": error,
                    })),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                )),
            }
        });

    // 模型调用响应路由
    let logger_for_model_response = state.logger.clone();
    let model_response_route = warp::path("api")
        .and(warp::path("model"))
        .and(warp::path("response"))
        .and(warp::post())
        .and(warp::body::json())
        .and_then(move |request: ModelCallResponseRequest| {
            let logger = logger_for_model_response.clone();
            async move {
                println!(
                    "🤖 Received model call response for request_id: {}",
                    request.request_id
                );

                let is_success = request
                    .is_success
                    .unwrap_or_else(|| is_model_error(&request.content).is_none());

                // 发送模型调用响应事件
                logger.send_model_call_response(
                    request.request_id.clone(),
                    request.content.clone(),
                    request.reasoning_content.clone(),
                    is_success,
                );

                if is_success {
                    match store_ai_response_to_database(&request.request_id, &request.content).await
                    {
                        Ok(_) => println!("✅ AI响应已成功存储到数据库"),
                        Err(e) => println!("❌ 存储AI响应到数据库失败: {}", e),
                    }
                } else {
                    println!("⚠️ 检测到模型错误响应,跳过存储到数据库");
                }

                // 返回成功响应
                let response = serde_json::json!({
                    "success": true,
                    "message": "Model response received successfully"
                });

                Ok::<_, warp::Rejection>(warp::reply::json(&response))
            }
        });

    // SSE日志流路由
    let logger_for_sse = state.logger.clone();
    let sse_logs_route = warp::path("api")
        .and(warp::path("logs"))
        .and(warp::path("stream"))
        .and(warp::get())
        .map(move || {
            println!("🔌 New SSE connection established");
            let receiver = logger_for_sse.subscribe();
            println!(
                "📻 SSE receiver created, current subscriber count: {}",
                logger_for_sse.subscriber_count()
            );

            let stream = BroadcastStream::new(receiver).filter_map(|result| async move {
                match result {
                    Ok(event) => {
                        println!("📤 Sending SSE event: {:?}", event);
                        let json_data = serde_json::to_string(&event).ok()?;

                        // 根据事件类型设置不同的event名称
                        let event_name = match &event {
                            crate::logger::SSEEvent::RequestLog(_) => "log",
                            crate::logger::SSEEvent::ModelCallRequest(_) => "model_call_request",
                            crate::logger::SSEEvent::ModelCallProgress(_) => "model_call_progress",
                            crate::logger::SSEEvent::ModelCallResponse(_) => "model_call_response",
                        };

                        Some(Ok::<_, warp::Error>(
                            warp::sse::Event::default()
                                .event(event_name)
                                .data(json_data),
                        ))
                    }
                    Err(e) => {
                        println!("❌ SSE stream error: {:?}", e);
                        None
                    }
                }
            });

            warp::sse::reply(stream)
        });

    let root_route = warp::path::end()
        .and(warp::get())
        .map(|| warp::reply::html(QUERY_TEST_PAGE_HTML));

    // 根路由的HEAD方法
    let app_handle_clone = state.app_handle.clone();
    let root_head_route = warp::path::end()
        .and(warp::head())
        .map(move || {
            if let Some(app) = &app_handle_clone {
                let _ = app.emit("ocs-head-received", ());
            }
            warp::reply::with_header("Hello,OCS", "content-type", "text/plain")
        });

    let cors = warp::cors()
        .allow_any_origin()
        .allow_headers(vec!["content-type"])
        .allow_methods(vec!["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"]);

    // 将需要记录日志的路由组合在一起（query路由已经有自己的详细日志记录）
    let logged_routes = status_route
        .or(time_route)
        .or(echo_route)
        .with(logging_middleware);

    // 模型调用进度路由（用于流式输出心跳）
    let logger_for_model_progress = state.logger.clone();
    let model_progress_route = warp::path("api")
        .and(warp::path("model"))
        .and(warp::path("progress"))
        .and(warp::post())
        .and(warp::body::json())
        .and_then(move |request: ModelCallProgressRequest| {
            let logger = logger_for_model_progress.clone();
            async move {
                println!(
                    "📶 Received model call progress for request_id: {}",
                    request.request_id
                );
                logger
                    .send_model_call_progress(request.request_id.clone(), request.content.clone());
                let response = serde_json::json!({
                    "success": true,
                    "message": "Model progress received successfully"
                });
                Ok::<_, warp::Rejection>(warp::reply::json(&response))
            }
        });

    // 登录路由：验证管理员token或用户token
    let login_route = warp::path("api")
        .and(warp::path("login"))
        .and(warp::post())
        .and(warp::body::json())
        .and_then(move |body: serde_json::Value| async move {
            let token = body
                .get("token")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if token.is_empty() {
                let resp = serde_json::json!({"success": false, "message": "token不能为空"});
                return Ok::<_, warp::Rejection>(warp::reply::json(&resp));
            }
            // 读取配置文件
            let config_path = {
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                exe_dir.join("config.json")
            };
            let config_str = std::fs::read_to_string(&config_path).unwrap_or_default();
            let config: serde_json::Value = serde_json::from_str(&config_str).unwrap_or_default();
            // 验证管理员token
            let admin_token = config
                .get("adminToken")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !admin_token.is_empty() && token == admin_token {
                let resp = serde_json::json!({"success": true, "role": "admin", "name": "管理员"});
                return Ok::<_, warp::Rejection>(warp::reply::json(&resp));
            }
            // 验证普通用户token
            if let Some(users) = config
                .get("multiUser")
                .and_then(|m| m.get("users"))
                .and_then(|u| u.as_array())
            {
                for user in users {
                    let user_token = user.get("token").and_then(|v| v.as_str()).unwrap_or("");
                    if !user_token.is_empty() && token == user_token {
                        let name = user.get("name").and_then(|v| v.as_str()).unwrap_or("用户");
                        let resp =
                            serde_json::json!({"success": true, "role": "user", "name": name});
                        return Ok::<_, warp::Rejection>(warp::reply::json(&resp));
                    }
                }
            }
            let resp = serde_json::json!({"success": false, "message": "token无效"});
            Ok::<_, warp::Rejection>(warp::reply::json(&resp))
        });

    // GET /api/models — 读取模型配置（需要管理员token验证）
    let models_get_route = warp::path("api")
        .and(warp::path("models"))
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and_then(|auth: Option<String>| async move {
            if !check_admin_token(&auth) {
                return Ok::<_, warp::Rejection>(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"success": false, "message": "未授权"})),
                    warp::http::StatusCode::UNAUTHORIZED,
                ));
            }
            let path = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("model_config.json");
            let data: serde_json::Value = std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(serde_json::json!({}));
            Ok::<_, warp::Rejection>(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"success": true, "data": data})),
                warp::http::StatusCode::OK,
            ))
        });

    // PUT /api/models — 写入模型配置（需要管理员token验证）
    let models_put_route = warp::path("api")
        .and(warp::path("models"))
        .and(warp::put())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json())
        .and_then(|auth: Option<String>, body: serde_json::Value| async move {
            if !check_admin_token(&auth) {
                return Ok::<_, warp::Rejection>(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"success": false, "message": "未授权"})),
                    warp::http::StatusCode::UNAUTHORIZED,
                ));
            }
            let path = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("model_config.json");
            match std::fs::write(&path, body.to_string()) {
                Ok(_) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"success": true})),
                    warp::http::StatusCode::OK,
                )),
                Err(e) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                    warp::reply::json(
                        &serde_json::json!({"success": false, "message": e.to_string()}),
                    ),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                )),
            }
        });

    // 组合所有路由（query路由和SSE路由不需要额外的日志中间件）
    let routes = root_route
        .or(root_head_route)
        .or(logged_routes)
        .or(query_route)
        .or(mark_pending_correction_route)
        .or(model_response_route)
        .or(model_progress_route)
        .or(sse_logs_route)
        .or(login_route)
        .or(models_get_route)
        .or(models_put_route)
        .with(cors);

    // 解析绑定地址
    let bind_ip: [u8; 4] = if bind_address == "0.0.0.0" {
        [0, 0, 0, 0]
    } else if bind_address == "127.0.0.1" {
        [127, 0, 0, 1]
    } else {
        // 尝试解析其他IP地址
        let parts: Vec<&str> = bind_address.split('.').collect();
        if parts.len() != 4 {
            return Err(format!("Invalid IP address format: {}", bind_address));
        }
        let mut ip = [0u8; 4];
        for (i, part) in parts.iter().enumerate() {
            match part.parse::<u8>() {
                Ok(octet) => ip[i] = octet,
                Err(_) => return Err(format!("Invalid IP address format: {}", bind_address)),
            }
        }
        ip
    };

    // 在后台启动服务器
    let server_handle = tokio::spawn(async move {
        warp::serve(routes).run((bind_ip, port)).await;
    });

    // 更新状态
    let result = {
        let mut info = state.info.lock();
        info.running = true;
        info.port = Some(port);
        // 根据绑定地址生成正确的URL
        let url_host = if bind_address == "0.0.0.0" {
            "localhost".to_string()
        } else {
            bind_address.clone()
        };
        info.url = Some(format!("http://{}:{}", url_host, port));
        info.clone()
    };

    // 存储服务器句柄
    *state.handle.lock() = Some(server_handle);

    begin_server_activity();

    Ok(result)
}

/// 停止HTTP服务器
///
/// # 参数
/// * `state` - 服务器状态管理
///
/// # 返回值
/// * `Ok(ServerInfo)` - 服务器停止成功,返回服务器信息
/// * `Err(String)` - 服务器停止失败,返回错误信息
#[tauri::command]
pub async fn stop_server(state: State<'_, ServerState>) -> Result<ServerInfo, String> {
    {
        let info = state.info.lock();
        if !info.running {
            return Ok(info.clone());
        }
    }

    // 停止服务器
    if let Some(handle) = state.handle.lock().take() {
        handle.abort();
    }

    end_server_activity();

    // 更新状态
    let result = {
        let mut info = state.info.lock();
        info.running = false;
        info.port = None;
        info.url = None;
        info.clone()
    };

    Ok(result)
}

/// 获取服务器状态
///
/// # 参数
/// * `state` - 服务器状态管理
///
/// # 返回值
/// * `Ok(ServerInfo)` - 返回当前服务器状态信息
#[tauri::command]
pub async fn get_server_status(state: State<'_, ServerState>) -> Result<ServerInfo, String> {
    let info = state.info.lock();
    Ok(info.clone())
}

/// 存储AI响应到数据库
///
/// # Arguments
/// * `request_id` - 请求ID
/// * `content` - AI响应内容
///
/// # Returns
/// * `Result<(), String>` - 成功返回Ok(()),失败返回错误信息
async fn store_ai_response_to_database(request_id: &str, content: &str) -> Result<(), String> {
    // 记录AI响应信息,准备存储到数据库
    println!(
        "📝 准备存储AI响应到数据库: request_id={}, content_length={}",
        request_id,
        content.len()
    );

    // 如果回答是"题目不完整,无法确定具体问题.",则记录日志
    if content.contains("题目不完整,无法确定具体问题.") {
        println!("⚠️ 检测到题目不完整 (in callback)");
    }

    // TODO: 目前无法在此处存储,因为缺少原始问题的标题 (Title).
    // 完整的存储逻辑已在 query_post_route 中实现,那里有完整的上下文.
    // 如果将来需要支持异步回调存储,需要实现通过 request_id 查找原始 title 的机制.

    Ok(())
}

fn is_timeout_like_model_failure(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("timeout")
        || lower.contains("超时")
        || lower.contains("no new tokens")
        || lower.contains("aborted")
        || lower.contains("abort")
        || lower.contains("cancelled")
        || lower.contains("canceled")
        || lower.contains("取消")
        || lower.contains("服务已停止")
}

/// 将模型失败文本映射为 RequestLog 状态码：
/// 未选择模型 → 400，超时类 → 408，其它 → 500
fn classify_model_failure(text: &str) -> Option<(u16, String)> {
    let err = is_model_error(text)?;
    if err.contains("未选择模型") || text.contains("未选择模型") {
        Some((400, "错误: 未选择模型".to_string()))
    } else if is_timeout_like_model_failure(&err) || is_timeout_like_model_failure(text) {
        Some((408, err))
    } else {
        Some((500, err))
    }
}

fn is_model_error(text: &str) -> Option<String> {
    let mut cleaned = text.trim().to_string();
    if cleaned.starts_with("```json") {
        cleaned = cleaned[7..].to_string();
    } else if cleaned.starts_with("```") {
        cleaned = cleaned[3..].to_string();
    }
    if cleaned.ends_with("```") {
        cleaned = cleaned[..cleaned.len() - 3].to_string();
    }
    let cleaned = cleaned.trim().to_string();

    if cleaned == "所有AI均查询失败" {
        return Some(cleaned);
    }

    // 兼容半角/全角冒号
    if cleaned.starts_with("错误:")
        || cleaned.starts_with("错误：")
        || cleaned.starts_with("Error:")
        || cleaned.starts_with("API 错误")
    {
        return Some(cleaned);
    }

    if cleaned.contains("\"error\"") {
        if let Ok(v) = serde_json::from_str::<Value>(&cleaned) {
            if let Some(err) = v.get("error") {
                if let Some(msg) = err.get("message").and_then(|m| m.as_str()) {
                    return Some(msg.to_string());
                }
                return Some(err.to_string());
            }
        }

        fn extract_last_balanced_json(text: &str) -> Option<String> {
            let bytes = text.as_bytes();
            let mut end: Option<usize> = None;
            let mut depth: i32 = 0;
            let mut i = bytes.len();
            while i > 0 {
                i -= 1;
                let b = bytes[i];
                if end.is_none() {
                    if b == b'}' {
                        end = Some(i);
                        depth = 1;
                        continue;
                    }
                } else {
                    if b == b'}' {
                        depth += 1;
                    } else if b == b'{' {
                        depth -= 1;
                        if depth == 0 {
                            let start = i;
                            let slice = &text[start..=end.unwrap()];
                            return Some(slice.to_string());
                        }
                    }
                }
            }
            None
        }

        if let Some(json_str) = extract_last_balanced_json(&cleaned) {
            if let Ok(v) = serde_json::from_str::<Value>(&json_str) {
                if let Some(err) = v.get("error") {
                    if let Some(msg) = err.get("message").and_then(|m| m.as_str()) {
                        return Some(msg.to_string());
                    }
                    return Some(err.to_string());
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod same_question_tests {
    use super::{
        classify_model_failure, exact_answers_conflict, parse_same_question_result,
        query_http_reply, validate_cached_answer,
    };
    use crate::database::QuestionMatch;
    use crate::types::{QueryData, QueryRequest, QueryResponse};
    use warp::Reply;

    #[test]
    fn parses_same_true_with_matched_id() {
        assert_eq!(
            parse_same_question_result(r#"{"same":true,"matched_id":42}"#),
            Some(42)
        );
        assert_eq!(
            parse_same_question_result("答案如下\n{\"same\": true, \"matched_id\": 7}\n"),
            Some(7)
        );
    }

    #[test]
    fn parses_same_false_or_invalid_as_none() {
        assert_eq!(parse_same_question_result(r#"{"same":false}"#), None);
        assert_eq!(parse_same_question_result("错误: 未选择模型"), None);
        assert_eq!(parse_same_question_result(""), None);
    }

    #[test]
    fn no_model_selected_is_400_not_500() {
        let (status, msg) = classify_model_failure("错误: 未选择模型").expect("classified");
        assert_eq!(status, 400);
        assert_eq!(msg, "错误: 未选择模型");
    }

    #[test]
    fn query_reply_uses_review_http_status() {
        let reply = query_http_reply(422, &QueryResponse::error("答案待复核".to_string()));
        assert_eq!(reply.into_response().status(), 422);
    }

    #[test]
    fn cached_letter_answer_is_decoded_before_current_option_validation() {
        let request = QueryRequest {
            title: "选择正确选项".to_string(),
            options: Some("A. 乙 B. 甲".to_string()),
            query_type: Some("单选题".to_string()),
        };
        let matched = QuestionMatch {
            id: 1,
            question: "选择正确选项".to_string(),
            options: Some("A. 甲 B. 乙".to_string()),
            answer: "A".to_string(),
            question_type: Some("单选题".to_string()),
            is_ai: false,
            is_pending_correction: false,
            score: 0.99,
        };

        assert_eq!(validate_cached_answer(&request, &matched), Ok("甲".to_string()));
    }

    #[test]
    fn conflicting_exact_answers_are_rejected_as_a_group() {
        let make_data = |id, answer: &str| QueryData {
            id,
            question: "同一道题".to_string(),
            answer: answer.to_string(),
            is_ai: false,
            is_pending_correction: false,
            search_evidence: None,
        };

        assert!(exact_answers_conflict(&[
            make_data(1, "甲"),
            make_data(2, "乙"),
        ]));
        assert!(!exact_answers_conflict(&[
            make_data(1, "甲"),
            make_data(2, "甲"),
        ]));
    }
}
