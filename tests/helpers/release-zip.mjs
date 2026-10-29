import {inflateRawSync} from 'node:zlib';
// Central-directory sizes handle both ordinary ZIPs and APK data descriptors.
export function zipFiles(bytes) {
  let end = -1;
  for (let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--) if(bytes.readUInt32LE(i)===0x06054b50 && i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
  if(end<0)throw Error('ZIP directory missing');
  const count=bytes.readUInt16LE(end+10),files=new Map();let at=bytes.readUInt32LE(end+16);
  for(let i=0;i<count;i++){
    if(bytes.readUInt32LE(at)!==0x02014b50)throw Error('Invalid ZIP entry');
    const method=bytes.readUInt16LE(at+10),size=bytes.readUInt32LE(at+20),nameSize=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32),offset=bytes.readUInt32LE(at+42);
    const name=bytes.subarray(at+46,at+46+nameSize).toString('utf8');
    if(files.has(name))throw Error('Duplicate ZIP entry');
    files.set(name,()=>{if(bytes.readUInt32LE(offset)!==0x04034b50)throw Error('Invalid ZIP local header');const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);const data=bytes.subarray(start,start+size);if(method===0)return data;if(method===8)return inflateRawSync(data);throw Error('Unsupported ZIP compression');});
    at+=46+nameSize+extra+comment;
  }
  return files;
}

export function androidManifest(bytes) {
  if(bytes.readUInt16LE(0)!==3 || bytes.readUInt32LE(4)!==bytes.length)throw Error('Invalid binary Android manifest');
  let strings=[],result={};
  for(let at=bytes.readUInt16LE(2);at<bytes.length;){
    const type=bytes.readUInt16LE(at),header=bytes.readUInt16LE(at+2),size=bytes.readUInt32LE(at+4);
    if(size<header||at+size>bytes.length)throw Error('Invalid XML chunk');
    if(type===1){
      const count=bytes.readUInt32LE(at+8),utf8=(bytes.readUInt32LE(at+16)&256)!==0,start=at+bytes.readUInt32LE(at+20);
      strings=Array.from({length:count},(_,i)=>{let p=start+bytes.readUInt32LE(at+header+4*i);if(utf8){if(bytes[p]&128)p+=2;else p++;let length=bytes[p++];if(length&128)length=((length&127)<<8)|bytes[p++];return bytes.subarray(p,p+length).toString('utf8');}let length=bytes.readUInt16LE(p);p+=2;if(length&32768){length=((length&32767)*65536)+bytes.readUInt16LE(p);p+=2;}return bytes.subarray(p,p+length*2).toString('utf16le');});
    }else if(type===0x102){
      const element=strings[bytes.readUInt32LE(at+20)],count=bytes.readUInt16LE(at+28),stride=bytes.readUInt16LE(at+26),start=at+16+bytes.readUInt16LE(at+24);
      for(let i=0;i<count;i++){const p=start+i*stride,name=strings[bytes.readUInt32LE(p+4)],raw=bytes.readUInt32LE(p+8),data=bytes.readUInt32LE(p+16),value=raw!==0xffffffff?strings[raw]:bytes[p+15]===3?strings[data]:data;if(element==='manifest'&&['package','versionName','versionCode'].includes(name))result[name]=value;if(element==='uses-sdk'&&name==='minSdkVersion')result.minSdk=value;}
    }
    at+=size;
  }
  return result;
}
