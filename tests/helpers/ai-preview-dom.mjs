// A rendering-only DOM double. The production mountAiPreview installs every handler.
// Requests and user edits are driven by tests; no production behavior is reimplemented.
class Element {
 constructor(tag){this.tagName=tag;this.hidden=false;this.disabled=false;this.checked=false;this.textContent='';this.children=[];this.ids=new Map();}
 set innerHTML(html){for(const [,id]of html.matchAll(/\bid="([^"]+)"/g))this.ids.set(id,new Element('control'));}
 querySelector(selector){return this.ids.get(selector.slice(1));}
 after(element){this.next=element;}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=children;}
}
export function aiPreviewDOM(t){
 const previous=globalThis.document,form=new Element('form');
 globalThis.document={createElement:tag=>new Element(tag),getElementById:id=>{if(id!=='rr-form')throw Error('Unexpected element '+id);return form;}};
 t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 return{id:name=>form.next.querySelector('#'+name)};
}
export function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
