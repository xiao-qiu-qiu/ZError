/** Flag access gates, not topics or entire quiz websites. A normal login link
 * in navigation and a visible answer followed by "view explanation" are fine. */
export function restrictedPageReason(text: string): string | null {
  const visible = text.replace(/\s+/g, ' ').trim()
  const gate = /(?:登录|登陆|注册|付费|支付|开通会员|购买|解锁).{0,16}(?:查看|阅读|获取|解锁).{0,8}(?:答案|解析|全文|内容)|(?:答案|解析|全文).{0,12}(?:登录|付费|会员|解锁)|(?:sign in|log in|subscribe).{0,25}(?:to (?:read|view|continue)|full (?:article|answer))/i
  const answerEntry = /(?:点击|点此)?查看(?:参考)?答案|答案.{0,4}(?:隐藏|未显示)/
  const explicitAnswer = /(?:参考答案|正确答案|答案)\s*[:：]\s*(?:[A-D](?=[\s、，,.]|$)|正确|错误|对|错)/i
  if (explicitAnswer.test(visible)) return null
  if (gate.test(visible) || (visible.length < 1200 && answerEntry.test(visible))) {
    return '页面含答案查看入口或访问限制，尚未取得可核验的答案或正文'
  }
  return null
}
