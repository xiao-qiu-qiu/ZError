export const buildOcsConfig = (port: number | null) => [{
  name: 'ZE题库(自建版)',
  homepage: 'http://app.zerror.cc',
  url: `http://localhost:${port || 3000}/query`,
  method: 'post',
  type: 'GM_xmlhttpRequest',
  responseType: 'json',
  headers: { 'Content-Type': 'application/json' },
  data: {
    title: '${title}',
    options: '${options}',
    type: '${type}',
    images: { handler: 'return env => env.images || []' },
    suggestion_title: { handler: "return env => env.suggestion_title || env.title || ''" },
    suggestion_options: { handler: "return env => env.suggestion_options || env.options || ''" },
  },
  handler: 'return (res)=>res.code === 0 ? [res.message, undefined] : [res.data.question,res.data.answer,{ai: res.data.is_ai}]',
}]
