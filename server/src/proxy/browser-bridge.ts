import type { AdditionalOrigins } from './origin-map.js';

/** Bridge fixed upstream URLs and credential-less API calls into the account origin. */
export function browserBridge(primary: string, localOrigin: string, origins: AdditionalOrigins = {}): string {
  const routes: Record<string,string> = { [new URL(primary).origin]: '' };
  if (new URL(primary).hostname === 'muse.ai') routes['https://www.muse.ai'] = '';
  for (const [alias, origin] of Object.entries(origins)) routes[new URL(origin).origin] = '/__muse/origin/' + alias;
  const config = JSON.stringify({ local: new URL(localOrigin).origin, routes }).replace(/</g, '\\u003c');
  return `(function(){'use strict';if(window.__museGatewayBridge)return;Object.defineProperty(window,'__museGatewayBridge',{value:true});
const config=${config};
function mapped(value){try{const url=new URL(value,location.href);const http=url.origin.replace(/^ws:/,'http:').replace(/^wss:/,'https:');if(Object.prototype.hasOwnProperty.call(config.routes,http)){const out=new URL(config.local);if(url.protocol==='ws:'||url.protocol==='wss:')out.protocol=out.protocol==='https:'?'wss:':'ws:';out.pathname=config.routes[http]+url.pathname;out.search=url.search;out.hash=url.hash;return out.href;}return url.href;}catch(e){return value;}}
function local(value){try{return new URL(value,location.href).origin===config.local;}catch(e){return false;}}
const nativeFetch=window.fetch;
window.fetch=function(input,init){let target=mapped(input instanceof Request?input.url:String(input));if(!local(target))return nativeFetch.call(this,input,init);if(input instanceof Request){const source=new Request(input,init);const options={method:source.method,headers:source.headers,mode:'same-origin',credentials:'same-origin',cache:source.cache,redirect:source.redirect,referrerPolicy:source.referrerPolicy,integrity:source.integrity,signal:source.signal};if(source.method!=='GET'&&source.method!=='HEAD'){options.body=source.body;options.duplex='half';}return nativeFetch.call(this,target,options);}return nativeFetch.call(this,target,Object.assign({},init,{credentials:'same-origin',mode:'same-origin'}));};
const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(method,url){const args=Array.from(arguments);args[1]=mapped(String(url));this.__museLocal=local(args[1]);return open.apply(this,args);};
XMLHttpRequest.prototype.send=function(){if(this.__museLocal)this.withCredentials=true;return send.apply(this,arguments);};
if(window.WebSocket){const Native=window.WebSocket;function GatewaySocket(url,protocols){return protocols===undefined?new Native(mapped(String(url))):new Native(mapped(String(url)),protocols);}Object.setPrototypeOf(GatewaySocket,Native);GatewaySocket.prototype=Native.prototype;window.WebSocket=GatewaySocket;}
if(window.EventSource){const Native=window.EventSource;function GatewayEvents(url,options){const target=mapped(String(url));return new Native(target,local(target)?Object.assign({},options,{withCredentials:true}):options);}Object.setPrototypeOf(GatewayEvents,Native);GatewayEvents.prototype=Native.prototype;window.EventSource=GatewayEvents;}
})();`;
}

export function injectBrowserBridge(html: string, primary: string, localOrigin: string, origins: AdditionalOrigins = {}): string {
  const script = '<script data-muse-gateway>' + browserBridge(primary, localOrigin, origins) + '</script>';
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, match => match + script);
  return script + html;
}
