import {transferHash,transferSize,isEnvelope,inspectEnvelope} from './e2ee.mjs';
import { createHash } from 'node:crypto';
import { isUploadId, validateUploadMetadata } from './upload-contract.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Owner-selected inert bytes for the existing Galaxy download/receipt protocol. */
export function createDeliveryControl({ all, save, authorize, json, bodyOf, binaryOf, assert, deviceId, transfers, clock, withJobWriteLock,appUpdate }) {
  const stamp = () => new Date(clock()).toISOString();
  const metadata = data => {
    try { return validateUploadMetadata(data); }
    catch (error) { assert(false, 400, error.message); }
  };
  const sameFile = (left, right) => left?.filename === right.filename && left?.sha256 === right.sha256 && left?.bytes === right.bytes;
  function storedInfo(id, bytes, file, publicUpdate) {
    assert(bytes,409,'저장된 전송 파일을 확인하지 못했습니다.');
    assert(transferHash(bytes)===file.sha256&&transferSize(bytes)===file.bytes,409,'저장된 파일 정보가 일치하지 않습니다.');
    if(!isEnvelope(bytes))return null; // Explicit public APK or legacy fixture, never an encrypted receipt.
    assert(!publicUpdate,409,'공개 APK와 암호화 전송을 바꿀 수 없습니다.');
    const envelope=inspectEnvelope(bytes);
    assert(envelope.meta.id===id&&envelope.meta.direction==='pc-phone'&&sameFile(envelope.meta,file),409,'저장된 암호문 대상이 일치하지 않습니다.');
    return {sha256:sha(bytes),recipientKeyIds:envelope.recipients.map(r=>r.kid).sort()};
  }
  function createJob(id,file) {
    const mime=/\.apk$/i.test(file.filename)?'application/vnd.android.package-archive':'application/octet-stream';
    return save({id,deviceId,kind:'delivery',request:{query:'휴대폰으로 보내기 · '+file.filename,delivery:'download',subject:file.filename},
      state:'download_ready',wakeStatus:'skipped',artifact:{...file,mime,createdAt:stamp()},artifacts:[{id:file.sha256,...file,mime}],
      createdAt:stamp(),events:[{at:stamp(),text:'휴대폰에 저장할 파일을 준비했습니다. 갤럭시 저장 확인을 기다립니다.'}]});
  }
  async function handle(req, res, path) {
    const match = path.match(/^\/api\/(deliveries|app-updates)\/([^/]+)$/);
    if (!match || !['POST','GET'].includes(req.method)) return false;
    // Paired phones may receive these files, but cannot authorize new deliveries.
    authorize(req, 'owner');
    const id = match[2],publicUpdate=match[1]==='app-updates';
    assert(isUploadId(id), 400, '전송 ID 형식을 확인하세요.');
    if(req.method==='GET'){
      await withJobWriteLock(async()=>{
        let job=all().find(job=>job.id===id);
        if(job)assert(job.kind==='delivery'&&(job.artifact?.transferEncoding==='public-app-update')===publicUpdate,409,'같은 전송 ID로 다른 작업이 등록되어 있습니다.');
        const stored=await transfers.read(id+'.bin');
        if(!job&&!stored){json(res,200,{job:null,storageChecked:true});return;}
        let recovered=false;
        if(!job){
          // A Storage write can survive a lost acknowledgement or failed job commit.
          // Check the envelope's transfer context; only endpoints can verify its GCM tag.
          // Never report a surviving object absent or overwrite it.
          assert(!publicUpdate&&isEnvelope(stored),409,'작업 기록 없는 파일을 확인해야 합니다. 미접수로 처리하지 않습니다.');
          const file=metadata(inspectEnvelope(stored).meta);
          storedInfo(id,stored,file,false);job=createJob(id,file);recovered=true;
        }
        json(res,200,{job,ciphertext:storedInfo(id,stored,job.artifact,publicUpdate),...(recovered?{recovered:true}:{})});
      });
      return true;
    }
    const descriptor=publicUpdate?await bodyOf(req):null;
    let filename;
    try { filename = publicUpdate?descriptor.filename:decodeURIComponent(req.headers['x-file-name'] || ''); }
    catch { assert(false, 400, '파일명을 확인하세요.'); }
    const expectedHash=publicUpdate?descriptor.sha256:req.headers['x-file-sha256'];
    metadata({ filename, sha256:expectedHash, bytes:1 });
    let bytes = publicUpdate?null:await binaryOf(req);
    const file = metadata({ filename, sha256:expectedHash, bytes:publicUpdate?descriptor.bytes:transferSize(bytes) });
    if(publicUpdate)file.transferEncoding='public-app-update';
    if(!publicUpdate)assert(transferHash(bytes) === file.sha256, 409, '전송 파일의 해시가 일치하지 않습니다.');
    await withJobWriteLock(async () => {
      const previous = all().find(job => job.id === id);
      if (previous) {
        assert(previous.kind === 'delivery' && sameFile(previous.artifact, file)&&previous.artifact.transferEncoding===file.transferEncoding, 409, '같은 전송 ID로 다른 파일이나 작업을 만들 수 없습니다.');
        const stored=await transfers.read(id+'.bin');
        json(res, 200, { job:previous, duplicate:true,ciphertext:storedInfo(id,stored,file,publicUpdate) }); return;
      }
      // An accepted public installer remains retryable even after the release catalog advances.
      if(publicUpdate)bytes=await appUpdate(descriptor);
      let stored=await transfers.read(id+'.bin');
      if(!stored){
        try{await transfers.put(id+'.bin',bytes);}
        catch(error){stored=await transfers.read(id+'.bin');if(!stored)throw error;}
        stored??=await transfers.read(id+'.bin');
      }
      const ciphertext=storedInfo(id,stored,file,publicUpdate);
      assert(publicUpdate||!isEnvelope(bytes)||ciphertext,409,'암호화 전송에 평문 파일을 사용할 수 없습니다.');
      const job=createJob(id,file);
      json(res, 201, { job,ciphertext });
    });
    return true;
  }
  return { handle };
}
