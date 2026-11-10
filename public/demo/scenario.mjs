// Public synthetic example. This is a UI walkthrough, not the PC review engine.
export const before='# 가상 해외 바이아웃 펀드 A 출자 검토서\n\n이 문서는 공개 데모용 가상 자료입니다.\n\n통화별 환노출은 USD와 EUR로 구분하며 헤지 계획은 분기별 점검으로 명시한다.\n';
export const keyMan='핵심 운용역 이탈 조항은 지정 운용역 이탈 시 신규 투자를 중단하고 출자자 협의를 진행한다고 명시한다.';
export const after=before+'\n## 보완 KEY_MAN\n\n'+keyMan+'\n\n출처: [DD_A#p003]\n';
export const evidence='가상 해외 바이아웃 펀드 A 실사 자료\n\n[DD_A#p002]\n통화별 환노출은 USD와 EUR로 구분하며 헤지 계획은 분기별 점검으로 명시한다.\n\n[DD_A#p003]\n'+keyMan+'\n\n이 자료는 가상 자료이며 실제 기관의 내부 정책 또는 펀드 자료가 아닙니다.';
export const guideline=JSON.stringify({kind:'공개 데모용 지침 예시',items:[{id:'FX_HEDGE',label:'환노출·헤지 계획'},{id:'KEY_MAN',label:'핵심 운용역 이탈 조항'},{id:'LPAC',label:'LP 자문위원회 참여권'}],policy:'근거가 없는 항목은 추가 자료 확인 필요로 유지'},null,2);
export const items=Object.freeze([
 Object.freeze({id:'FX_HEDGE',label:'환노출·헤지 계획',status:'SATISFIED',note:'검토서에 통화 구분과 분기별 헤지 점검이 명시돼 있습니다.',quote:'통화별 환노출은 USD와 EUR로 구분하며 헤지 계획은 분기별 점검으로 명시한다.',citation:'DD_A#p002'}),
 Object.freeze({id:'KEY_MAN',label:'핵심 운용역 이탈 조항',status:'MISSING_WITH_EVIDENCE',note:'검토서에는 빠져 있지만 실사 자료에 보완할 근거가 있습니다.',quote:keyMan,citation:'DD_A#p003'}),
 Object.freeze({id:'LPAC',label:'LP 자문위원회 참여권',status:'MISSING_NO_EVIDENCE',note:'샘플 자료에 근거가 없습니다. 추가 자료 또는 운용사 확인이 필요합니다.',quote:'',citation:''})
]);
export const initialState=(revision=0)=>({revision,phase:'prepared',body:before,reviewComplete:false});
export function transition(state,action,revision){
 if(action==='reset')return initialState(state.revision+1);
 if(revision!==state.revision)throw Error('STALE_DEMO_ACTION');
 if(action==='approve'&&state.phase==='prepared')return{revision:state.revision+1,phase:'saved',body:after,reviewComplete:false};
 if(action==='reject'&&state.phase==='prepared')return{...state,revision:state.revision+1,phase:'rejected'};
 if(action==='recheck'&&['saved','rechecked'].includes(state.phase))return{...state,revision:state.revision+1,phase:'rechecked'};
 throw Error('DEMO_ACTION_UNAVAILABLE');
}
export function savedItems(){return items.map(i=>i.id==='KEY_MAN'?{...i,status:'SATISFIED',note:'가상 수정본에 실사 자료의 근거와 출처가 반영됐습니다.'}:{...i});}

const transferExamples=Object.freeze({
 original:Object.freeze({name:'샘플 자료.pdf',preview:'허용 폴더에서 찾은 샘플 자료.pdf를 원본 그대로 보냅니다.'}),
 text:Object.freeze({name:'샘플 자료.txt',preview:'샘플 자료.pdf에서 읽은 내용을 TXT로 변환해 보냅니다.'}),
});
export const initialTransfer=()=>({phase:'idle',preview:null,last:null});
export function transferStep(state,action,request){
 if(action==='choose')return {...state,phase:'idle',preview:null};
 if(action==='request'&&request==='recent')return {...state,phase:state.last?'forwarded':'missing',preview:null};
 if(action==='request'&&Object.hasOwn(transferExamples,request))return {...state,phase:'approval',preview:transferExamples[request]};
 if(action==='approve'&&state.phase==='approval')return {phase:'received',preview:null,last:state.preview};
 return state;
}
