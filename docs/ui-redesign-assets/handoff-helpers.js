/* 文档交接参考，经典 script/CommonJS 双兼容；不由正式index装载，不读写真实Store。
   只示范名称/分类/隐藏草稿。源生命周期与分类级联须复用正式业务语义。 */
(function (root) {
  'use strict';
  const clone=v=>JSON.parse(JSON.stringify(v));
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  function resolveUnique(stations,url) {
    const matches=stations.filter(s=>s.u.includes(url));
    if(matches.length!==1)throw new Error(matches.length?'源URL匹配多个电台，请重新选择':'电台已失配，请重新加载');
    return matches[0];
  }
  function basicProjection(cfg,s) {
    // 同对象所有可编辑配置均纳入冲突检测；全局分类名变化由validation再复核。
    const out={urls:s.u.slice(),name:s.n,category:s.c,hidden:!!s.hidden,maps:{}};
    for(const map of ['names','moves','hideS','tag','srcs','srcManualOrder','srcDisabled','srcLabels']){
      out.maps[map]={};
      for(const u of s.u)if(Object.prototype.hasOwnProperty.call(cfg[map]||{},u))out.maps[map][u]=clone(cfg[map][u]);
    }
    return out;
  }
  function buildBasicCfg(latest,s,draft,base) {
    const next=clone(latest),patch=draft.patch;
    for(const map of ['names','moves','hideS','tag'])if(!next[map])next[map]={};
    for(const u of s.u){
      if(Object.prototype.hasOwnProperty.call(patch,'name')){
        const name=patch.name.trim();
        if(name===(s.dName||s.n))delete next.names[u];else next.names[u]=name;
      }
      if(Object.prototype.hasOwnProperty.call(patch,'category')){
        const category=patch.category;
        const def=(next.renames||{})[s.dCat]||s.dCat||s.c;
        if(category===def)delete next.moves[u];else next.moves[u]=category;
      }
      if(Object.prototype.hasOwnProperty.call(patch,'hidden')){
        if(patch.hidden)next.hideS[u]=1;else delete next.hideS[u];
      }
      const has=s.u.some(x=>['names','moves','hideS','srcs','srcLabels'].some(m=>(next[m]||{})[x]))
        ||!!(next.srcManualOrder||{})[s.u[0]]||!!(next.srcDisabled||{})[s.u[0]];
      if(has)next.tag[u]=s.dName||base.name;else delete next.tag[u];
    }
    return next;
  }
  function createEditor(io) {
    // io函数均由调用方明确注入，异步弹窗不能隐式吞错误。
    let draft=null,saving=false;
    const paint=()=>io.render(draft?clone(draft):null,saving);
    async function save() {
      if(!draft||saving)return false;
      saving=true;paint();
      try{
        // 弹窗等待期间可能再收到他页更新，每次都对最新对象重校验。
        for(let attempt=0;attempt<4;attempt++){
          const s=io.resolve(draft.identityUrl),latest=io.readCfg();
          const projection=io.project(latest,s);
          const error=io.validate(s,draft.patch,latest);
          if(error){draft.error=error;paint();return false;}
          if(!same(projection,draft.base)){
            draft.conflict=true;paint();
            const choice=await io.confirmConflict(clone(draft),clone(projection));
            if(choice==='reload'){draft={identityUrl:s.u[0],base:clone(projection),patch:{},dirty:false,error:'',conflict:false};paint();return false;}
            if(choice!=='overwrite')return false;
            const current=io.resolve(draft.identityUrl),fresh=io.readCfg();
            if(!same(io.project(fresh,current),projection))continue;
            // 同步提交段不插入await；依然只有Store既有LWW保证。
            io.commit(io.buildNext(fresh,current,draft,draft.base));
          }else{
            io.commit(io.buildNext(latest,s,draft,draft.base));
          }
          const rebound=io.resolve(draft.identityUrl);
          draft={identityUrl:rebound.u[0],base:clone(io.project(io.readCfg(),rebound)),patch:{},dirty:false,error:'',conflict:false};
          paint();return true;
        }
        draft.error='对象持续变化，请重新加载后再保存';paint();return false;
      }catch(e){if(draft){draft.error=e.message||'保存失败';paint();}return false;}
      finally{saving=false;paint();}
    }
    return {
      getDraft:()=>draft?clone(draft):null,
      begin(url){const s=io.resolve(url);draft={identityUrl:s.u[0],base:clone(io.project(io.readCfg(),s)),patch:{},dirty:false,error:'',conflict:false};paint();},
      change(field,value){if(!draft||saving)return;if(!['name','category','hidden'].includes(field))throw new Error('不允许编辑此字段');if(same(value,draft.base[field]))delete draft.patch[field];else draft.patch[field]=value;draft.dirty=Object.keys(draft.patch).length>0;draft.error='';paint();},
      cancel(){if(!draft||saving)return;const s=io.resolve(draft.identityUrl);draft={identityUrl:s.u[0],base:clone(io.project(io.readCfg(),s)),patch:{},dirty:false,error:'',conflict:false};paint();},
      externalChanged(){if(draft){try{draft.conflict=!same(io.project(io.readCfg(),io.resolve(draft.identityUrl)),draft.base);}catch(e){draft.conflict=true;draft.error=e.message;}paint();}},
      async depart(next){if(saving)return false;if(draft&&draft.dirty){const choice=await io.confirmLeave(clone(draft));if(choice==='stay')return false;if(choice==='save'&&!await save())return false;if(choice!=='save'&&choice!=='discard')return false;}next();return true;},
      save
    };
  }
  function chooseDialog(dialog, title, message, choices) {
    if(dialog.open)return Promise.reject(new Error('确认对话框仍在使用'));
    return new Promise(resolve=>{
      dialog.replaceChildren();
      const heading=document.createElement('h2'),body=document.createElement('p'),actions=document.createElement('div');
      heading.id=dialog.id+'-heading';heading.textContent=title;body.textContent=message;
      dialog.setAttribute('aria-labelledby',heading.id);actions.className='settings-choices';
      let done=false;
      function finish(value){if(done)return;done=true;dialog.removeEventListener('cancel',cancel);dialog.removeEventListener('close',closed);if(dialog.open)dialog.close();resolve(value);}
      function cancel(e){e.preventDefault();finish('stay');}
      function closed(){if(!dialog.open)finish('stay');} // 忽略上一轮排队到新一轮的close事件
      dialog.addEventListener('cancel',cancel);dialog.addEventListener('close',closed);
      for(const choice of choices){const button=document.createElement('button');button.type='button';button.className=choice.value==='save'?'primary-btn':'secondary-btn';button.textContent=choice.label;button.addEventListener('click',()=>finish(choice.value),{once:true});actions.appendChild(button);}
      dialog.append(heading,body,actions);dialog.showModal();
      const safe=choices.findIndex(x=>x.value==='stay');actions.children[safe>=0?safe:0].focus();
    });
  }
  const api={resolveUnique,basicProjection,buildBasicCfg,createEditor,chooseDialog};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.VRadioUIHandoff=api;
})(typeof window!=='undefined'?window:globalThis);