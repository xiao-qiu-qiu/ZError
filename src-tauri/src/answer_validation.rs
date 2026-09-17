use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModelAnswer {
    pub answer: String,
    pub needs_review: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnswerKind {
    Single,
    Multiple,
    Choice,
    Judgement,
    Completion,
    Other,
}

#[derive(Debug, Default)]
struct ParsedOptions {
    by_letter: HashMap<char, String>,
    values: Vec<String>,
}

fn detect_answer_kind(question_type: Option<&str>) -> AnswerKind {
    let raw = question_type.unwrap_or_default().trim();
    let normalized = raw.to_lowercase();

    if normalized.contains("single") || raw.contains("单选") || raw.contains("单项选择") {
        AnswerKind::Single
    } else if normalized.contains("multiple") || raw.contains("多选") || raw.contains("多项选择")
    {
        AnswerKind::Multiple
    } else if normalized.contains("judgement")
        || normalized.contains("judgment")
        || raw.contains("判断")
    {
        AnswerKind::Judgement
    } else if normalized.contains("completion") || raw.contains("填空") {
        AnswerKind::Completion
    } else if normalized.contains("choice") || raw.contains("选择") {
        AnswerKind::Choice
    } else {
        AnswerKind::Other
    }
}

fn parse_labeled_options(options: &str) -> ParsedOptions {
    let normalized = options.replace("\r\n", "\n");
    let Ok(label_re) = Regex::new(r"(?i)(^|\s)([A-Z])[\.、．\)）]\s*") else {
        return ParsedOptions::default();
    };
    let matches: Vec<_> = label_re.captures_iter(&normalized).collect();
    if matches.len() < 2 {
        return ParsedOptions::default();
    }

    let mut parsed = ParsedOptions::default();
    for (index, captures) in matches.iter().enumerate() {
        let Some(label_match) = captures.get(2) else {
            continue;
        };
        let Some(letter) = label_match
            .as_str()
            .chars()
            .next()
            .map(|value| value.to_ascii_uppercase())
        else {
            continue;
        };
        let Some(whole_match) = captures.get(0) else {
            continue;
        };
        let end = matches
            .get(index + 1)
            .and_then(|next| next.get(0))
            .map(|next| next.start())
            .unwrap_or(normalized.len());
        let text = normalized[whole_match.end()..end].trim();
        if text.is_empty() || parsed.by_letter.contains_key(&letter) {
            return ParsedOptions::default();
        }
        parsed.by_letter.insert(letter, text.to_string());
        parsed.values.push(text.to_string());
    }

    if parsed.values.len() < 2 {
        ParsedOptions::default()
    } else {
        parsed
    }
}

fn parse_options(options: Option<&str>) -> ParsedOptions {
    let Some(options) = options.map(str::trim).filter(|value| !value.is_empty()) else {
        return ParsedOptions::default();
    };

    let labeled = parse_labeled_options(options);
    if !labeled.values.is_empty() {
        return labeled;
    }

    let values: Vec<String> = options
        .replace("\r\n", "\n")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    ParsedOptions {
        by_letter: HashMap::new(),
        values,
    }
}

fn strip_matching_label(text: &str, options: &ParsedOptions) -> String {
    let Ok(label_re) = Regex::new(r"(?i)^([A-Z])[\.、．\)）]\s*(.+)$") else {
        return text.trim().to_string();
    };
    let trimmed = text.trim();
    let Some(captures) = label_re.captures(trimmed) else {
        return trimmed.to_string();
    };
    let letter = captures
        .get(1)
        .and_then(|value| value.as_str().chars().next())
        .map(|value| value.to_ascii_uppercase());
    let rest = captures.get(2).map(|value| value.as_str().trim());
    match (letter, rest) {
        (Some(letter), Some(rest))
            if options.by_letter.get(&letter).map(String::as_str) == Some(rest) =>
        {
            rest.to_string()
        }
        _ => trimmed.to_string(),
    }
}

fn normalize_choice_answer(answer: &str, options: &ParsedOptions) -> String {
    let raw_parts: Vec<&str> = if answer.contains("###") {
        answer.split("###").collect()
    } else {
        vec![answer]
    };
    let mut normalized = Vec::new();

    for raw_part in raw_parts {
        let original = raw_part.trim();
        if options.values.iter().any(|value| value == original) {
            normalized.push(original.to_string());
            continue;
        }
        let part = strip_matching_label(original, options);
        if part.is_empty() {
            continue;
        }
        let compact: String = part
            .chars()
            .filter(|value| !value.is_whitespace())
            .collect();
        if !options.by_letter.is_empty()
            && !compact.is_empty()
            && compact.chars().all(|value| value.is_ascii_alphabetic())
        {
            let mapped: Option<Vec<String>> = compact
                .chars()
                .map(|letter| options.by_letter.get(&letter.to_ascii_uppercase()).cloned())
                .collect();
            if let Some(mapped) = mapped {
                normalized.extend(mapped);
                continue;
            }
        }
        normalized.push(part);
    }

    normalized.join("###")
}

fn answer_parts(answer: &str) -> Result<Vec<String>, String> {
    let parts: Vec<String> = answer
        .split("###")
        .map(str::trim)
        .map(str::to_string)
        .collect();
    if parts.is_empty() || parts.iter().any(|part| part.is_empty()) {
        return Err("答案为空或包含空答案段".to_string());
    }
    Ok(parts)
}

fn validate_choice(
    answer: &str,
    options: Option<&str>,
    kind: AnswerKind,
) -> Result<String, String> {
    let parsed_options = parse_options(options);
    if parsed_options.values.len() < 2 {
        return Err("选择题缺少可识别的选项".to_string());
    }

    let normalized = normalize_choice_answer(answer, &parsed_options);
    let mut parts = answer_parts(&normalized)?;
    if kind == AnswerKind::Single && parts.len() != 1 {
        return Err("单选题必须且只能有一个答案".to_string());
    }

    let mut seen = HashSet::new();
    for part in &parts {
        if !parsed_options.values.iter().any(|option| option == part) {
            return Err(format!("答案不在题目选项中：{}", part));
        }
        if !seen.insert(part.clone()) {
            return Err(format!("答案包含重复选项：{}", part));
        }
    }
    parts.sort_by_key(|part| {
        parsed_options
            .values
            .iter()
            .position(|option| option == part)
            .unwrap_or(usize::MAX)
    });
    Ok(parts.join("###"))
}

fn detectable_blank_count(question: &str) -> usize {
    let Ok(blank_re) =
        Regex::new(r"（\s*[_＿]{2,}\s*）|\(\s*[_＿]{2,}\s*\)|（\s*）|\(\s*\)|[_＿]{2,}")
    else {
        return 0;
    };
    blank_re.find_iter(question).count()
}

pub(crate) fn validate_and_normalize_answer(
    answer: &str,
    question: &str,
    options: Option<&str>,
    question_type: Option<&str>,
) -> Result<String, String> {
    let trimmed = answer.trim();
    if trimmed.is_empty() {
        return Err("答案为空".to_string());
    }

    match detect_answer_kind(question_type) {
        kind @ (AnswerKind::Single | AnswerKind::Multiple | AnswerKind::Choice) => {
            validate_choice(trimmed, options, kind)
        }
        AnswerKind::Judgement => {
            let normalized = trimmed.to_lowercase();
            if ["正确", "对", "是", "true", "√"].contains(&normalized.as_str()) {
                Ok("正确".to_string())
            } else if ["错误", "错", "否", "false", "×"].contains(&normalized.as_str()) {
                Ok("错误".to_string())
            } else {
                Err("判断题答案必须能明确归一为“正确”或“错误”".to_string())
            }
        }
        AnswerKind::Completion => {
            let parts = answer_parts(trimmed)?;
            let blank_count = detectable_blank_count(question);
            if blank_count > 0 && parts.len() != blank_count {
                return Err(format!(
                    "填空题有 {} 个空，但答案包含 {} 段",
                    blank_count,
                    parts.len()
                ));
            }
            Ok(parts.join("###"))
        }
        AnswerKind::Other => Ok(trimmed.to_string()),
    }
}

fn extract_json_objects(text: &str) -> Vec<&str> {
    let mut objects = Vec::new();
    let mut start = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (index, character) in text.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }

        match character {
            '"' if depth > 0 => in_string = true,
            '{' => {
                if depth == 0 {
                    start = Some(index);
                }
                depth += 1;
            }
            '}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    if let Some(start) = start.take() {
                        objects.push(&text[start..index + character.len_utf8()]);
                    }
                }
            }
            _ => {}
        }
    }

    objects
}

fn count_answer_objects(value: &Value) -> usize {
    match value {
        Value::Object(map) => {
            usize::from(map.contains_key("answer"))
                + map.values().map(count_answer_objects).sum::<usize>()
        }
        Value::Array(values) => values.iter().map(count_answer_objects).sum(),
        _ => 0,
    }
}

pub(crate) fn parse_model_answer(content: &str) -> Result<ModelAnswer, String> {
    let mut candidate = None;
    let mut answer_object_count = 0usize;

    for fragment in extract_json_objects(content) {
        let Ok(value) = serde_json::from_str::<Value>(fragment) else {
            continue;
        };
        answer_object_count += count_answer_objects(&value);

        let Value::Object(map) = value else {
            continue;
        };
        let Some(answer_value) = map.get("answer") else {
            continue;
        };
        let Some(answer) = answer_value.as_str() else {
            return Err("模型输出中的 answer 必须是字符串".to_string());
        };
        let needs_review = match map.get("needs_review") {
            None => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => return Err("模型输出中的 needs_review 必须是布尔值".to_string()),
        };
        candidate = Some(ModelAnswer {
            answer: answer.to_string(),
            needs_review,
        });
    }

    if answer_object_count > 1 {
        return Err("模型输出包含多个 answer 对象".to_string());
    }
    candidate.ok_or_else(|| "模型输出缺少唯一的 answer JSON 对象".to_string())
}

#[cfg(test)]
mod tests {
    use super::{parse_model_answer, validate_and_normalize_answer};

    #[test]
    fn parses_braces_inside_answer_string() {
        let parsed =
            parse_model_answer(r#"说明 {忽略}\n{"answer":"集合 {1, 2}","needs_review":true}"#)
                .expect("parse final answer object");
        assert_eq!(parsed.answer, "集合 {1, 2}");
        assert!(parsed.needs_review);
    }

    #[test]
    fn rejects_multiple_answer_objects() {
        let error = parse_model_answer(r#"{"answer":"A"}\n{"answer":"B"}"#)
            .expect_err("reject multiple answers");
        assert!(error.contains("多个"));
    }

    #[test]
    fn parses_same_line_and_unlabeled_options() {
        assert_eq!(
            validate_and_normalize_answer("B", "题目", Some("A. foo B. bar C. baz"), Some("单选"),)
                .expect("same-line option"),
            "bar"
        );
        assert_eq!(
            validate_and_normalize_answer("bar", "题目", Some("foo\nbar\nbaz"), Some("单选"),)
                .expect("line options"),
            "bar"
        );
        assert_eq!(
            validate_and_normalize_answer("C", "题目", Some("A. C B） 氧 C. 氮"), Some("单选"),)
                .expect("option text wins over letter mapping"),
            "C"
        );
    }

    #[test]
    fn validates_multiple_choice_as_unique_option_set() {
        assert!(validate_and_normalize_answer(
            "A###A",
            "题目",
            Some("A. foo\nB. bar"),
            Some("多选"),
        )
        .is_err());
        assert_eq!(
            validate_and_normalize_answer("BA", "题目", Some("A. foo\nB. bar"), Some("多选"),)
                .expect("valid choice set"),
            "foo###bar"
        );
    }

    #[test]
    fn keeps_non_choice_single_letters() {
        assert_eq!(
            validate_and_normalize_answer("C、H、O、N", "元素", None, Some("填空"))
                .expect("completion answer"),
            "C、H、O、N"
        );
        assert_eq!(
            validate_and_normalize_answer("√", "判断题", None, Some("判断"))
                .expect("judgement synonym"),
            "正确"
        );
    }

    #[test]
    fn validates_detectable_completion_blank_count() {
        assert!(validate_and_normalize_answer(
            "北京",
            "首都是____，最大城市是（ ）",
            None,
            Some("填空"),
        )
        .is_err());
        assert!(validate_and_normalize_answer(
            "北京###上海",
            "首都是____，最大城市是（ ）",
            None,
            Some("填空"),
        )
        .is_ok());
    }
}
