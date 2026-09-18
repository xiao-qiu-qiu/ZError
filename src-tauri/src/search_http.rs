use std::time::Duration;

/// Bounded fallback for anomalous public-search results through a system proxy.
/// The caller supplies a query, never a destination URL or authentication header.
#[tauri::command]
pub async fn search_bing_direct(query: String, timeout_seconds: u64) -> Result<String, String> {
    let query = query.trim().chars().take(500).collect::<String>();
    if query.is_empty() {
        return Err("搜索词为空".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            // Bing redirects mainland requests to its regional search host.
            let url = attempt.url();
            if attempt.previous().len() < 3
                && url.scheme() == "https"
                && matches!(url.host_str(), Some("www.bing.com" | "cn.bing.com"))
                && url.port_or_known_default() == Some(443)
                && url.username().is_empty()
                && url.password().is_none()
            {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .timeout(Duration::from_secs(timeout_seconds.clamp(5, 60)))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .build()
        .map_err(|_| "直连搜索初始化失败".to_string())?;
    let mut response = client
        .get("https://www.bing.com/search")
        .query(&[("q", query.as_str()), ("format", "rss")])
        .send()
        .await
        .map_err(|_| "Bing 直连搜索请求失败或超时".to_string())?;
    if !response.status().is_success() {
        return Err(format!("Bing 直连搜索 HTTP {}", response.status()));
    }
    const MAX_BYTES: usize = 2_000_000;
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err("搜索响应过大".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "搜索响应读取失败或超时".to_string())?
    {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("搜索响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "搜索响应不是有效的 UTF-8".into())
}
