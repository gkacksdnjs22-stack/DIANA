"""Scratch NumPy character BiGRU. No product imports, pretrained weights or labels in inference."""
import json, math, re, unicodedata, hashlib
import numpy as np

STATUSES=['ready','needs_clarification','unsupported','cancel_requested']
INTENTS=['checklist_review','patch','convert','save','export','cancel','question','mixed','unknown']
FIELDS=['target_doc','source_ids','guideline_id','format','request']
CODES=['none','missing','ambiguous','unavailable','unsupported','non_action','cancel']
FORMATS=[None,'md','txt','json']
FORMAT_CLASSES=[None]+[(o,v) for o in ['context','request'] for v in ['md','txt','json']]
ROLES=['review','source','guideline']
FORMAT_NAMES={'md':['md','markdown','마크다운'],'txt':['txt','text','텍스트'],'json':['json']}

def normalize(s): return ' '.join(unicodedata.normalize('NFKC',s).lower().split())
def utf16_offsets(s):
    out=[0]
    for ch in s: out.append(out[-1]+len(ch.encode('utf-16-le'))//2)
    return out
def normalized_map(s):
    chars=[]; starts=[]; ends=[]
    for i,ch in enumerate(s):
        for c in unicodedata.normalize('NFKC',ch).lower():
            if c.isspace():
                if chars and chars[-1]==' ': ends[-1]=i+1
                else: chars.append(' '); starts.append(i); ends.append(i+1)
            else: chars.append(c); starts.append(i); ends.append(i+1)
    return ''.join(chars),starts,ends
def input_strings(x):
    # ID strings have no dedicated embedding/class. IDs only participate in mention matching.
    yield x['request']
    for c in x['candidates']:
        yield c['display_name']
        yield from c['aliases']
def make_vocab(inputs): return {'<PAD>':0,'<UNK>':1,**{c:i+2 for i,c in enumerate(sorted(set(''.join(s for x in inputs for s in input_strings(x)))))}}
def preprocess(x,vocab):
    if set(x)!= {'schema_version','request','context','candidates'}: raise ValueError('ANNOTATION_OR_UNKNOWN_INPUT_FIELD')
    if set(x['context'])!={'allowed_action','confirmed_format'}: raise ValueError('CONTEXT_FIELDS')
    if x['context']['allowed_action']!='checklist_review': raise ValueError('ACTION')
    request=x['request']; offsets=utf16_offsets(request)
    ids=np.array([vocab.get(c,1) for c in request],dtype=np.int64)
    catalog=sorted(x['candidates'],key=lambda c:c['id']) # canonical set order, no first-candidate selection rule
    for c in catalog:
        if set(c)!={'id','display_name','aliases','roles'}: raise ValueError('CANDIDATE_FIELDS')
    meta=[np.array([vocab.get(ch,1) for ch in '\n'.join([c['display_name'],*c['aliases']])],dtype=np.int64) for c in catalog]
    roles=np.array([[float(r in c['roles']) for r in ROLES] for c in catalog],dtype=np.float32).reshape(-1,3)
    norm,starts,ends=normalized_map(request); pairs=[]
    def occurrences(name):
        key=normalize(name); at=norm.find(key)
        while at>=0:
            a,b=starts[at],ends[at+len(key)-1]
            # Round-trip to the unchanged contract's normalization; retain every occurrence.
            if normalize(request[a:b])==key: yield a,b
            at=norm.find(key,at+1)
    for ci,c in enumerate(catalog):
        seen=set()
        for name in [c['id'],c['display_name'],*c['aliases']]:
            for a,b in occurrences(name):
                if (a,b) in seen: continue
                seen.add((a,b)); pairs.append({'ci':ci,'id':c['id'],'a':a,'b':b,'span':{'start':offsets[a],'end':offsets[b]},'kind':'document'})
    pairs.sort(key=lambda p:(p['id'],p['a'],p['b']))
    document_count=len(pairs)
    for value,names in FORMAT_NAMES.items():
        seen=set()
        for name in names:
            for a,b in occurrences(name):
                if (a,b) in seen: continue
                seen.add((a,b));pairs.append({'ci':-1,'id':None,'a':a,'b':b,'span':{'start':offsets[a],'end':offsets[b]},'kind':'format','literal_value':value})
    ctx=np.eye(4,dtype=np.float32)[FORMATS.index(x['context']['confirmed_format'])]
    duplicate=max([sum(q['span']==p['span'] for q in pairs[:document_count]) for p in pairs[:document_count]] or [0])
    return {'input':x,'ids':ids,'catalog':catalog,'meta':meta,'roles':roles,'pairs':pairs,'document_count':document_count,'ctx':ctx,
            'counts':np.array([len(catalog)/10,document_count/10,duplicate/2],dtype=np.float32)}

def softmax(x):
    e=np.exp(x-np.max(x)); return e/e.sum()
def sigmoid(x): return 1/(1+np.exp(-np.clip(x,-40,40)))

class Model:
    def __init__(self,vocab,config,seed=0):
        self.vocab=vocab; self.config=config; self.rng=np.random.default_rng(seed); self.p={}
        self.d=config['embedding'];self.h=config['hidden'];self.g=config['global_hidden'];self.k=config['pair_hidden']
        d,h,g,k=self.d,self.h,self.g,self.k
        def weight(name,shape,scale=None):self.p[name]=(self.rng.normal(0,scale or math.sqrt(2/sum(shape)),shape)).astype(np.float32)
        def bias(name,n):self.p[name]=np.zeros(n,np.float32)
        weight('E',(len(vocab),d),.08); self.p['E'][0]=0
        for direction in ['f','b']:
            weight(direction+'W',(d,3*h));weight(direction+'U',(h,3*h));bias(direction+'b',3*h)
        self.global_dim=4*h+d+4+3+3;self.pair_dim=6*h+d+3+g+4+3
        weight('G',(self.global_dim,g));bias('Gb',g)
        weight('O',(g,55));bias('Ob',55) # 4 status + 9 intent + 7 format + 5*7 issues
        weight('N',(g,2));bias('Nb',2)
        weight('P',(self.pair_dim,k));bias('Pb',k);weight('Q',(k,4));bias('Qb',4)
    def count(self):return sum(v.size for v in self.p.values())
    def gru(self,X,mask,direction):
        W,U,b=self.p[direction+'W'],self.p[direction+'U'],self.p[direction+'b']; B,T,_=X.shape;h=self.h
        xw=X@W+b; output=np.zeros((B,T,h),np.float32);prev=np.zeros((B,h),np.float32);cache=[]
        order=range(T) if direction=='f' else range(T-1,-1,-1)
        for t in order:
            zr=sigmoid(xw[:,t,:2*h]+prev@U[:,:2*h]);z,r=zr[:,:h],zr[:,h:]
            n=np.tanh(xw[:,t,2*h:]+(r*prev)@U[:,2*h:]);m=mask[:,t,None]
            state=((1-z)*prev+z*n)*m+prev*(1-m)
            output[:,t]=state*m;cache.append((t,prev,z,r,n,m));prev=state
        return output,(X,cache)
    def gru_back(self,dout,cache,direction,grad):
        X,steps=cache;W,U=self.p[direction+'W'],self.p[direction+'U'];h=self.h
        dh=np.zeros((X.shape[0],h),np.float32);da=np.zeros((X.shape[0],X.shape[1],3*h),np.float32);du=np.zeros_like(U)
        for t,prev,z,r,n,m in reversed(steps):
            total=dh+dout[:,t]*m;active=total*m
            dz=active*(n-prev)*z*(1-z);dn=active*z*(1-n*n)
            drh=dn@U[:,2*h:].T;dr=drh*prev*r*(1-r)
            both=np.concatenate([dz,dr],axis=1)
            dh=total*(1-m)+active*(1-z)+drh*r+both@U[:,:2*h].T
            da[:,t]=np.concatenate([dz,dr,dn],axis=1)
            du[:,:2*h]+=prev.T@both;du[:,2*h:]+=(r*prev).T@dn
        grad[direction+'W']+=X.reshape(-1,self.d).T@da.reshape(-1,3*h);grad[direction+'U']+=du;grad[direction+'b']+=da.sum(axis=(0,1))
        return da@W.T
    def forward(self,items):
        B=len(items);lengths=[len(x['ids']) for x in items];T=max(lengths);ids=np.zeros((B,T),np.int64);mask=np.zeros((B,T),np.float32)
        for i,x in enumerate(items):ids[i,:lengths[i]]=x['ids'];mask[i,:lengths[i]]=1
        X=self.p['E'][ids];f,fc=self.gru(X,mask,'f');b,bc=self.gru(X,mask,'b');H=np.concatenate([f,b],axis=2);cache=[]
        for i,x in enumerate(items):
            L=lengths[i];meta=np.array([self.p['E'][ids_].mean(axis=0) for ids_ in x['meta']],np.float32).reshape(-1,self.d)
            meanmeta=meta.mean(axis=0) if len(meta) else np.zeros(self.d,np.float32)
            rolemean=x['roles'].mean(axis=0) if len(meta) else np.zeros(3,np.float32)
            v=np.concatenate([H[i,:L].mean(axis=0),H[i,L-1,:self.h],H[i,0,self.h:],meanmeta,x['ctx'],rolemean,x['counts']])
            gh=np.tanh(v@self.p['G']+self.p['Gb']);out=gh@self.p['O']+self.p['Ob'];null=gh@self.p['N']+self.p['Nb']
            features=[]
            for p in x['pairs']:
                a,b=p['a'],p['b'];cm=meta[p['ci']] if p['ci']>=0 else self.p['E'][x['ids'][a:b]].mean(axis=0)
                cr=x['roles'][p['ci']] if p['ci']>=0 else np.zeros(3,np.float32)
                features.append(np.concatenate([H[i,a],H[i,b-1],H[i,a:b].mean(axis=0),cm,cr,gh,x['ctx'],np.array([a/L,b/L,(b-a)/L],np.float32)]))
            features=np.array(features,np.float32).reshape(-1,self.pair_dim);ph=np.tanh(features@self.p['P']+self.p['Pb']);scores=ph@self.p['Q']+self.p['Qb']
            cache.append({'x':x,'L':L,'meta':meta,'v':v,'gh':gh,'out':out,'null':null,'features':features,'ph':ph,'scores':scores})
        return cache,(ids,H,fc,bc)
    def backward(self,caches,enc,douts,dnulls,dscores):
        ids,H,fc,bc=enc;grad={k:np.zeros_like(v) for k,v in self.p.items()};dH=np.zeros_like(H)
        for i,(c,do,dn,ds) in enumerate(zip(caches,douts,dnulls,dscores)):
            x=c['x'];grad['O']+=np.outer(c['gh'],do);grad['Ob']+=do;grad['N']+=np.outer(c['gh'],dn);grad['Nb']+=dn
            dg=do@self.p['O'].T+dn@self.p['N'].T
            grad['Q']+=c['ph'].T@ds;grad['Qb']+=ds.sum(axis=0)
            dp=(ds@self.p['Q'].T)*(1-c['ph']**2);grad['P']+=c['features'].T@dp;grad['Pb']+=dp.sum(axis=0);df=dp@self.p['P'].T
            dm=np.zeros_like(c['meta'])
            for j,p in enumerate(x['pairs']):
                a,b=p['a'],p['b'];v=df[j];hh=2*self.h
                dH[i,a]+=v[:hh];dH[i,b-1]+=v[hh:2*hh];dH[i,a:b]+=v[2*hh:3*hh]/(b-a)
                me=v[3*hh:3*hh+self.d]
                if p['ci']>=0:dm[p['ci']]+=me
                else:np.add.at(grad['E'],x['ids'][a:b],me/(b-a))
                dg+=v[3*hh+self.d+3:3*hh+self.d+3+self.g]
            dg*=1-c['gh']**2;grad['G']+=np.outer(c['v'],dg);grad['Gb']+=dg;dv=dg@self.p['G'].T
            hh=2*self.h;dH[i,:c['L']]+=dv[:hh]/c['L'];dH[i,c['L']-1,:self.h]+=dv[hh:hh+self.h];dH[i,0,self.h:]+=dv[hh+self.h:2*hh]
            if len(dm):dm+=dv[2*hh:2*hh+self.d]/len(dm)
            for j,mid in enumerate(x['meta']):np.add.at(grad['E'],mid,dm[j]/len(mid))
        dX=self.gru_back(dH[:,:,:self.h],fc,'f',grad)+self.gru_back(dH[:,:,self.h:],bc,'b',grad)
        np.add.at(grad['E'],ids.ravel(),dX.reshape(-1,self.d));grad['E'][0]=0
        return grad
    def save(self,path):np.savez_compressed(path,**self.p)
    def load(self,path):
        with np.load(path,allow_pickle=False) as z:
            if set(z.files)!=set(self.p):raise ValueError('CHECKPOINT_KEYS')
            for k in self.p:
                if self.p[k].shape!=z[k].shape:raise ValueError('CHECKPOINT_SHAPE')
                self.p[k]=z[k].copy()
    def digest(self):return hashlib.sha256(b''.join(k.encode()+v.tobytes() for k,v in sorted(self.p.items()))).hexdigest()

def pair_index(x,binding):
    if binding is None:return 0
    for j,p in enumerate(x['pairs'][:x['document_count']]):
        if p['id']==binding['id'] and p['span']==binding['span']:return j+1
    raise ValueError('GOLD_MENTION_NOT_IN_INPUT_CANDIDATES')

def objective(caches,targets,backward=True):
    B=len(caches);total=0.;douts=[];dnulls=[];dscores=[];terms={}
    for c,t in zip(caches,targets):
        x=c['x'];do=np.zeros_like(c['out']);dn=np.zeros_like(c['null']);ds=np.zeros_like(c['scores']);nd=x['document_count']
        def ce(logits,label,name,weight=1):
            nonlocal total
            p=softmax(logits);loss=-math.log(max(float(p[label]),1e-30))*weight/B;total+=loss;terms[name]=terms.get(name,0)+loss
            d=p.copy();d[label]-=1;return d*weight/B
        do[:4]=ce(c['out'][:4],STATUSES.index(t['status']),'status');do[4:13]=ce(c['out'][4:13],INTENTS.index(t['intent']),'intent')
        for j,field in enumerate(FIELDS):
            found=[a['code'] for a in t['issues'] if a['field']==field]
            if len(found)>1:raise ValueError('MULTIPLE_CODES_NOT_SUPPORTED_IN_THIS_DATA')
            sl=slice(20+j*7,27+j*7);do[sl]=ce(c['out'][sl],CODES.index(found[0] if found else 'none'),'issues',.2)
        # Arguments in unsupported/cancel/unknown rows are unannotated for REVIEW, not null labels.
        if t['intent']=='checklist_review':
            for role,field in [(0,'target_doc'),(1,'guideline_id')]:
                scores=np.concatenate([c['null'][role:role+1],c['scores'][:nd,role]])
                d=ce(scores,pair_index(x,t[field]),field);dn[role]+=d[0];ds[:nd,role]+=d[1:]
            gold={b['id']:b for b in t['source_ids']};N=len(x['catalog'])
            for ci,candidate in enumerate(x['catalog']):
                indices=[j for j,p in enumerate(x['pairs'][:nd]) if p['ci']==ci]
                if not indices:
                    if candidate['id'] in gold:raise ValueError('GOLD_SOURCE_WITHOUT_MENTION')
                    continue # fixed zero selection for candidates with no mention; no trainable dummy span
                best=max(indices,key=lambda j:float(c['scores'][j,2]));logit=float(c['scores'][best,2]);label=float(candidate['id'] in gold)
                loss=float(np.logaddexp(0,logit)-label*logit)/max(N,1)/B;total+=loss;terms['source_set']=terms.get('source_set',0)+loss
                ds[best,2]+=(sigmoid(logit)-label)/max(N,1)/B
                if label:
                    correct=pair_index(x,gold[candidate['id']])-1
                    ds[indices,2]+=ce(c['scores'][indices,2],indices.index(correct),'source_span',.5/max(len(gold),1))
            form=t['format'];label=0 if form is None else FORMAT_CLASSES.index((form['origin'],form['value']))
            do[13:20]=ce(c['out'][13:20],label,'format')
            if form is not None and form['origin']=='request':
                indices=list(range(nd,len(x['pairs'])));correct=next((j for j in indices if x['pairs'][j]['span']==form['span']),None)
                if correct is None:raise ValueError('GOLD_FORMAT_SPAN_NOT_FOUND')
                ds[indices,3]+=ce(c['scores'][indices,3],indices.index(correct),'format_span',.5)
        douts.append(do);dnulls.append(dn);dscores.append(ds)
    return total,(douts,dnulls,dscores),terms

def decode(c):
    x=c['x'];nd=x['document_count'];ps=softmax(c['out'][:4]);pi=softmax(c['out'][4:13]);pf=softmax(c['out'][13:20]);status=STATUSES[int(ps.argmax())];intent=INTENTS[int(pi.argmax())]
    raw={'status':status,'intent':intent,'target_doc':None,'source_ids':[],'guideline_id':None,'format':None,'issues':[]};arg_conf=[];details={}
    def binding(p):return {'id':p['id'],'span':dict(p['span'])}
    for role,field in [(0,'target_doc'),(1,'guideline_id')]:
        p=softmax(np.concatenate([c['null'][role:role+1],c['scores'][:nd,role]]));j=int(p.argmax());raw[field]=None if j==0 else binding(x['pairs'][j-1]);arg_conf.append(float(p[j]));details[field]={'probability':float(p[j]),'choice_index':j}
    source_probabilities=[]
    for ci,candidate in enumerate(x['catalog']):
        indices=[j for j,p in enumerate(x['pairs'][:nd]) if p['ci']==ci]
        if not indices:source_probabilities.append({'id':candidate['id'],'probability':0.,'mention_available':False});continue
        best=max(indices,key=lambda j:float(c['scores'][j,2]));prob=float(sigmoid(c['scores'][best,2]));source_probabilities.append({'id':candidate['id'],'probability':prob,'mention_available':True,'span':x['pairs'][best]['span']})
        if prob>=.5:raw['source_ids'].append(binding(x['pairs'][best]));arg_conf.append(prob)
        else:arg_conf.append(1-prob)
    fc=int(pf.argmax());arg_conf.append(float(pf[fc]))
    if fc:
        origin,value=FORMAT_CLASSES[fc];sp=None
        if origin=='request' and len(x['pairs'])>nd:
            best=nd+int(c['scores'][nd:,3].argmax());sp=x['pairs'][best]['span']
        raw['format']={'origin':origin,'value':value,'span':sp}
    for j,field in enumerate(FIELDS):
        p=softmax(c['out'][20+j*7:27+j*7]);code=CODES[int(p.argmax())]
        if code!='none':raw['issues'].append({'field':field,'code':code})
    assembled=json.loads(json.dumps(raw))
    # Non-review arguments have no gold supervision. Output suppression depends ONLY on predicted labels.
    if intent!='checklist_review' or status in ['unsupported','cancel_requested']:
        assembled.update(target_doc=None,source_ids=[],guideline_id=None,format=None)
    assembled={'schema_version':1,**assembled,'scores':{'kind':'uncalibrated_probability','intent':float(pi.max()),'arguments':min(arg_conf) if arg_conf else 0.}}
    return {'output':assembled,'raw_heads':raw,'confidence':{'status':float(ps.max()),'intent':float(pi.max()),'arguments':min(arg_conf) if arg_conf else 0.},
            'status_distribution':dict(zip(STATUSES,map(float,ps))),'intent_distribution':dict(zip(INTENTS,map(float,pi))),
            'selection_scores':details,'source_probabilities':source_probabilities,'decoder':'argmax; source sigmoid >= 0.5; no confidence gate; predicted non-review argument suppression'}

class Adam:
    def __init__(self,model,lr):self.lr=lr;self.t=0;self.m={k:np.zeros_like(v) for k,v in model.p.items()};self.v={k:np.zeros_like(v) for k,v in model.p.items()}
    def step(self,model,grad,clip=5):
        norm=math.sqrt(sum(float(np.sum(v.astype(np.float64)**2)) for v in grad.values()))
        if not math.isfinite(norm):raise ValueError('NONFINITE_GRADIENT')
        scale=min(1.,clip/max(norm,1e-12));self.t+=1
        for k,p in model.p.items():
            g=grad[k]*scale;self.m[k]=.9*self.m[k]+.1*g;self.v[k]=.999*self.v[k]+.001*g*g
            p-=self.lr*(self.m[k]/(1-.9**self.t))/(np.sqrt(self.v[k]/(1-.999**self.t))+1e-8)
        model.p['E'][0]=0
        return norm

def predict(model,items,batch=12):
    result=[]
    for at in range(0,len(items),batch):
        cache,_=model.forward(items[at:at+batch]);result.extend(decode(c) for c in cache)
    return result
