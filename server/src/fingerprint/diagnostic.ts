import type { IncomingHttpHeaders } from 'node:http';
import type { Fingerprint } from '../types.js';
import { fingerprintHeaders } from './profile.js';
import { injectAccountFingerprint } from './document.js';
import type { AdvancedFingerprintOptions } from './advanced.js';

const safeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Account-origin diagnostics, with explicitly selected headers and no session/token echo. */
export function fingerprintDiagnostic(fp: Fingerprint, headers: IncomingHttpHeaders, options?: AdvancedFingerprintOptions): string {
  const configured = safeJson(fp);
  const output = fingerprintHeaders(headers, fp);
  const headerView = safeJson({ userAgent: output['user-agent'] ?? null, acceptLanguage: output['accept-language'] ?? null,
    clientHints: Object.fromEntries(Object.entries(output).filter(([name]) => name.toLowerCase().startsWith('sec-ch-ua'))) });
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>账号指纹自检</title>
<style>body{background:#10141c;color:#e9edf6;font:15px system-ui,sans-serif;margin:0;padding:24px;line-height:1.6}h1{font-size:24px}h2{font-size:18px}p{color:#b6bed0}section{border:1px solid #354057;border-radius:12px;padding:18px;margin:16px 0}pre{white-space:pre-wrap;word-break:break-word;font-size:13px}button{min-height:44px;padding:8px 18px;background:#b7c4ff;color:#14204d;border:0;border-radius:8px}#result{color:#aee6c5}</style></head><body>
<h1>账号指纹自检</h1><p>本页与 Muse 使用同一账号 Origin、同一注入脚本。这里显示实际读数，不代表通过任何网站的识别检测。</p>
<button id="recheck" type="button">重新检测</button><p id="result" role="status">正在检测…</p>
<section><h2>页面实际读数</h2><pre id="observed"></pre></section>
<section><h2>配置</h2><pre id="configured"></pre></section>
<section><h2>服务端上游请求头预览</h2><pre id="headers"></pre><p>此处是共用请求头处理函数的输出；不发送探测到外部站点。</p></section>
<section><h2>覆盖范围</h2><p>UA、语言、Intl 默认时区、Date 时区偏移、screen 元数据、CPU/内存字段及可选读出扰动。screen 设置不会改变窗口排版尺寸。WebRTC 开关启用时阻断 RTCPeerConnection，可能影响音视频。</p><p>TLS 浏览器模板作用于服务器上游连接；WebSocket 使用同一模板但升级响应 Cookie 尚未同步。Worker 模式覆盖同账号普通/模块/Shared/Blob Worker，ServiceWorker 保持原生。标准字体模式加载 DejaVu Sans 并覆盖页面与 Canvas 字体；系统字体枚举、CJK/emoji 缺字回退、阴影 DOM 保持客户端相关。WebGPU 可保持原生或关闭暴露，不模拟另一块 GPU。浏览器内核与未覆写的 Date 本地方法保持原生；脚本可以被检测或绕过。Canvas 噪声只处理 sRGB RGBA8 二维画布不透明像素，P3/HDR、OffscreenCanvas 与非二维导出保持原生。Audio 读取返回副本，写入请使用 copyToChannel，可能影响依赖原生可写视图的页面。Number/Array 的 toLocaleString 保持原生。</p></section>
<script>
const config=${configured};const headers=${headerView};
document.getElementById('configured').textContent=JSON.stringify(config,null,2);
document.getElementById('headers').textContent=JSON.stringify(headers,null,2);
function hash(data){let h=2166136261;for(let i=0;i<data.length;i++){h=Math.imul(h^data[i],16777619);}return(h>>>0).toString(16);}
async function inspect(){
 await Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,2000))]);
 const observed={userAgent:navigator.userAgent,platform:navigator.platform,language:navigator.language,languages:navigator.languages,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,timezoneOffset:new Date().getTimezoneOffset(),januaryOffset:new Date('2025-01-15T12:00:00Z').getTimezoneOffset(),julyOffset:new Date('2025-07-15T12:00:00Z').getTimezoneOffset(),hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:navigator.deviceMemory??null,screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight,pixelRatio:devicePixelRatio},viewport:{width:innerWidth,height:innerHeight},webdriver:navigator.webdriver,userAgentData:navigator.userAgentData??null};
 try{const canvas=document.createElement('canvas');canvas.width=240;canvas.height=80;const ctx=canvas.getContext('2d');ctx.fillStyle='#3b548a';ctx.fillRect(0,0,240,80);ctx.font='18px sans-serif';ctx.fillStyle='#fff';ctx.fillText('Muse account fingerprint',8,40);const first=ctx.getImageData(0,0,240,80).data;const second=ctx.getImageData(0,0,240,80).data;observed.canvas={readHash:hash(first),stableRead:hash(first)===hash(second),stableExport:canvas.toDataURL()===canvas.toDataURL()};}catch(e){observed.canvas={error:String(e.name)}}
 try{const canvas=document.createElement('canvas');const gl=canvas.getContext('webgl');const ext=gl&&gl.getExtension('WEBGL_debug_renderer_info');observed.webgl=ext?{vendor:gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),renderer:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}:{available:false};}catch(e){observed.webgl={error:String(e.name)}}
 try{if(typeof RTCPeerConnection==='undefined')observed.webRTC='不支持';else{const pc=new RTCPeerConnection();pc.close();observed.webRTC='可用'}}catch(e){observed.webRTC='已阻断：'+e.name}
 observed.webGPU={exposed:!!navigator.gpu};observed.font={family:getComputedStyle(document.body).fontFamily,loaded:Array.from(document.fonts).some(face=>face.family.replaceAll('"','')==='Muse Standard'&&face.status==='loaded'),localFontAccess:typeof window.queryLocalFonts};
 observed.transport={selected:config.enabled?(config.tlsProfile||'native'):'native',scope:'服务器上游连接；本页不计算 TLS 指纹'};
 try{observed.worker=await new Promise(resolve=>{const url=URL.createObjectURL(new Blob(['postMessage({ua:navigator.userAgent,language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,cores:navigator.hardwareConcurrency,webGPU:!!navigator.gpu})'],{type:'text/javascript'}));let worker;const timer=setTimeout(()=>{worker?.terminate();URL.revokeObjectURL(url);resolve({error:'timeout'})},3000);worker=new Worker(url);worker.onmessage=e=>{clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);resolve(e.data)};worker.onerror=()=>{clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);resolve({error:'unsupported'})};});}catch(e){observed.worker={error:e.name}}
 document.getElementById('observed').textContent=JSON.stringify(observed,null,2);window.__museFingerprintObserved=observed;
 document.getElementById('result').textContent=config.enabled?'检测完成：已开启账号指纹；请比较配置与实际读数。':'检测完成：兼容模式，页面保持原生参数。';
}
document.getElementById('recheck').onclick=inspect;inspect();
</script></body></html>`;
  return injectAccountFingerprint(html, fp, options);
}
