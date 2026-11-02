import {BlockList,isIP} from 'node:net';

function canonicalIP(value){
  if(!isIP(value))throw Error('INVALID_PROXY_IP');
  const ip=isIP(value)===4?value:new URL('http://['+value+']/').hostname.slice(1,-1);
  const mapped=/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(ip);
  if(!mapped)return ip;
  const n=parseInt(mapped[1]+mapped[2].padStart(4,'0'),16);
  return[n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.');
}
export function sourceResolver(trustedProxyIPs=[]){
  const trusted=new BlockList();
  for(const value of trustedProxyIPs){const ip=canonicalIP(value);trusted.addAddress(ip,isIP(ip)===4?'ipv4':'ipv6');}
  const isTrusted=ip=>trusted.check(ip,isIP(ip)===4?'ipv4':'ipv6');
  return req=>{
    let peer=canonicalIP(req.socket.remoteAddress);
    // Trust headers only through explicitly allowlisted immediate peers, walking right to left.
    const forwarded=req.headers['x-forwarded-for'];
    if(!isTrusted(peer)||typeof forwarded!=='string'||forwarded.length>2048)return peer;
    const chain=forwarded.split(',').map(x=>x.trim());
    if(chain.length>20||chain.some(x=>!isIP(x)))return peer;
    for(let i=chain.length-1;i>=0&&isTrusted(peer);i--)peer=canonicalIP(chain[i]);
    return peer;
  };
}
export class StagingRateLimits {
  constructor({now=Date.now,windowMs=60000,maxSources=5000}={}){
    this.now=now;this.windowMs=windowMs;this.maxSources=maxSources;this.swept=0;
    this.buckets={read:new Map(),anonymous:new Map(),administrator:new Map()};
  }
  allow(lane,key){
    const now=this.now(),buckets=this.buckets;
    if(now-this.swept>=this.windowMs){for(const map of Object.values(buckets))for(const[k,v]of map)if(v.until<=now)map.delete(k);this.swept=now;}
    const map=buckets[lane];if(!map)throw Error('INVALID_RATE_LANE');
    let item=map.get(key);
    if(!item||item.until<=now){
      if(!item&&map.size>=this.maxSources)return false;
      item={count:0,until:now+this.windowMs};map.set(key,item);
    }
    return ++item.count<=(lane==='anonymous'?30:120);
  }
}
