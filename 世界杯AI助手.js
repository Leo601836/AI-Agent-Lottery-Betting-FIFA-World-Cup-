/*! 世界杯AI助手 (WCAgent) — 嵌入式网页 AI agent
 *  能力：悬浮窗唤起 + 选中文本唤起 + 对话问答 + 执行页面操作(技能/连接器/MCP) + 流式输出
 *  LLM：默认 Puter.js(免Key·浏览器原生·免费, 路由到 GLM)；可切换 GLM 官方(bigmodel.cn, 自备免费Key)
 *  接入：在任意页面 </body> 前加一行 <script src="世界杯AI助手.js"></script> 即可
 *  扩展：window.WCAgent.registerSkill / registerConnector / registerMCP
 *  红线：不编造数据 / 北京时间 / 理性娱乐·未成年人禁止购彩
 */
(function(){
  'use strict';
  if (window.__WC_AI_LOADED__) return;
  window.__WC_AI_LOADED__ = true;

  /* ============ 配置与状态 ============ */
  var LS_KEY = 'wc_ai_cfg_v1';
  var DEFAULTS = {
    provider: 'puter',                         // 'puter' | 'glm'
    puterModel: 'z-ai/glm-4.7-flash',          // 也可 z-ai/glm-5.1 / z-ai/glm-5
    glmKey: '',
    glmModel: 'glm-4.7-flash',                 // 也可 glm-5.1 等
    glmBase: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    temperature: 0.7,
    autoAct: true                              // 是否允许 agent 执行页面操作
  };
  function loadCfg(){ try{ return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY)||'{}')); }catch(e){ return Object.assign({},DEFAULTS); } }
  function saveCfg(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(CFG)); }catch(e){} }
  var CFG = loadCfg();
  var HISTORY = [];   // [{role, content}] 不含 system

  function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  /* ============ 技能 / 连接器 / MCP 注册表 ============ */
  var SKILLS = new Map();   // name -> {name, description, parameters, run, source}
  function registerSkill(def){
    if(!def || !def.name || typeof def.run!=='function'){ console.warn('[WCAgent] 无效技能', def); return; }
    SKILLS.set(def.name, Object.assign({parameters:{}, description:'', source:'custom'}, def));
    try{ renderSkillList(); }catch(e){}
    return def.name;
  }
  function unregisterSkill(name){ SKILLS.delete(name); try{ renderSkillList(); }catch(e){} }

  // 连接器：本质是一个用 fetch 取外部数据的技能
  function registerConnector(def){
    return registerSkill({
      name: def.name,
      description: (def.description||'') + '（连接器/外部数据）',
      parameters: def.parameters||{},
      source: 'connector',
      run: async function(args){
        var url = (typeof def.url==='function') ? def.url(args) : def.url;
        var opt = { method: def.method||'GET', headers: def.headers||{} };
        if(def.body){ opt.body = JSON.stringify(def.body(args)); opt.headers=Object.assign({'Content-Type':'application/json'},opt.headers); }
        var res = await fetch(url, opt);
        var txt = await res.text(); var data;
        try{ data = JSON.parse(txt); }catch(e){ data = txt; }
        if(def.parse) return def.parse(data, args);
        return (typeof data==='string') ? data.slice(0,4000) : JSON.stringify(data).slice(0,4000);
      }
    });
  }

  // MCP over HTTP(JSON-RPC 2.0)桥接：需要可达的 MCP HTTP 端点
  var MCP_SERVERS = [];
  async function mcpRpc(def, method, params){
    var res = await fetch(def.url, { method:'POST',
      headers: Object.assign({'Content-Type':'application/json'}, def.headers||{}),
      body: JSON.stringify({ jsonrpc:'2.0', id:Date.now(), method:method, params:params||{} }) });
    var j = await res.json();
    if(j.error) throw new Error(j.error.message||'MCP 错误');
    return j.result;
  }
  async function registerMCP(def){
    MCP_SERVERS.push(def);
    var r = await mcpRpc(def, 'tools/list', {});
    var tools = (r && r.tools) || [];
    tools.forEach(function(t){
      registerSkill({
        name: def.name+'__'+t.name,
        description: '[MCP·'+def.name+'] '+(t.description||t.name),
        parameters: (t.inputSchema && t.inputSchema.properties) ? t.inputSchema.properties : {},
        source: 'mcp',
        run: async function(args){
          var rr = await mcpRpc(def, 'tools/call', { name:t.name, arguments:args||{} });
          if(rr && rr.content) return rr.content.map(function(c){ return c.text||''; }).join('\n');
          return JSON.stringify(rr).slice(0,4000);
        }
      });
    });
    return tools.length;
  }

  /* ============ 内置页面操作技能 ============ */
  var TABS = {bet:'竞猜投注', combo:'组合计算', sched:'赛程比分', stand:'小组排名', teams:'球队', prov:'福建·浙江', news:'新闻'};
  function activeSection(){ return document.querySelector('main section.show') || document.querySelector('section.show'); }
  function visibleText(limit){ var s=activeSection(); var t=(s?s.innerText:document.body.innerText)||''; t=t.replace(/\n{3,}/g,'\n\n').trim(); return limit? t.slice(0,limit): t; }
  function briefVisible(){ var t=visibleText(300); return t? ('当前可见摘要：'+t.replace(/\s+/g,' ').slice(0,260)+'…') : ''; }
  function findOnPage(query){
    query=(query||'').trim(); if(!query) return '请提供查找关键词';
    var root=document.querySelector('main')||document.body;
    var all=root.querySelectorAll('td,th,div,span,h1,h2,h3,h4,p,li,button,a');
    var hit=null;
    for(var i=0;i<all.length;i++){ var el=all[i];
      if((el.textContent||'').indexOf(query)>=0){
        var childHit=false, cs=el.children;
        for(var j=0;j<cs.length;j++){ if((cs[j].textContent||'').indexOf(query)>=0){childHit=true;break;} }
        if(!childHit){ hit=el; break; }
      }
    }
    if(!hit) return '页面当前可见内容中未找到「'+query+'」（可先 switch_tab 切到相关页再找）';
    try{ hit.scrollIntoView({behavior:'smooth', block:'center'}); }catch(e){}
    hit.classList.add('wcai-hl'); setTimeout(function(){ hit.classList.remove('wcai-hl'); }, 2600);
    var ctx=(hit.innerText||hit.textContent||'').replace(/\s+/g,' ').trim();
    return '已定位并高亮「'+query+'」。上下文：'+ctx.slice(0,400);
  }
  registerSkill({ name:'list_tabs', source:'builtin', description:'列出面板所有可切换标签页', parameters:{},
    run: async function(){ return Object.keys(TABS).map(function(k){return k+'='+TABS[k];}).join('；'); } });
  registerSkill({ name:'switch_tab', source:'builtin', description:'切换到指定标签页并返回该页可见摘要',
    parameters:{tab:'标签键，取值之一：bet/combo/sched/stand/teams/prov/news（也可传中文名）'},
    run: async function(a){ var tab=(a&&a.tab||'').trim();
      if(!TABS[tab]){ for(var k in TABS){ if(TABS[k].indexOf(tab)>=0||tab.indexOf(TABS[k])>=0){ tab=k; break; } } }
      if(!TABS[tab]) return '未知标签：'+(a&&a.tab)+'。可用：'+Object.keys(TABS).join('/');
      if(typeof window.go==='function') window.go(tab);
      else { var b=document.querySelector('#nav button[data-t="'+tab+'"]'); if(b) b.click(); }
      await sleep(140); return '已切到「'+TABS[tab]+'」。'+briefVisible(); } });
  registerSkill({ name:'read_view', source:'builtin', description:'读取当前可见标签页的文本内容(用于回答页面上有什么)', parameters:{},
    run: async function(){ return visibleText(4000)||'(当前页无可读文本)'; } });
  registerSkill({ name:'find_on_page', source:'builtin', description:'在页面查找关键词,滚动并高亮第一处匹配,返回上下文',
    parameters:{query:'要查找的关键词,如球队名/比赛/玩法'}, run: async function(a){ return findOnPage(a&&a.query); } });
  registerSkill({ name:'get_update_status', source:'builtin', description:'读取面板顶部"最近更新"状态条(更新时间/赔率源/红线说明)', parameters:{},
    run: async function(){ var u=document.getElementById('updTag'); return u? (u.innerText||u.textContent).replace(/\s+/g,' ').trim().slice(0,1500) : '未找到更新状态条(可能不在世界杯面板上)'; } });
  registerSkill({ name:'get_selection', source:'builtin', description:'获取用户当前在页面上选中的文本', parameters:{},
    run: async function(){ var s=String(window.getSelection?window.getSelection():'').trim(); return s||'(当前没有选中文本)'; } });

  /* ============ 系统提示 ============ */
  function skillSpec(){
    var lines=[]; SKILLS.forEach(function(s){
      var ps=Object.keys(s.parameters||{}).map(function(k){return k+':'+s.parameters[k];}).join(', ');
      lines.push('- '+s.name+'('+ps+') —— '+s.description);
    }); return lines.join('\n');
  }
  function sysPrompt(){
    return [
      '你是「世界杯竞猜助手」，嵌入在《2026世界杯·竞猜投注助手》网页里。职责：理解并解读页面内容、回答 2026 世界杯竞猜/赔率/赛程相关问题，并可执行页面操作帮用户导航与查数据。',
      '全程用简体中文回答，语气专业、简洁。',
      '',
      '【可用技能】（需要时调用，每次只调用一个）：',
      skillSpec(),
      '',
      '【执行操作的方式】当你需要操作页面或读取页面数据时，只输出一个动作代码块，块内是 JSON，不要输出其它任何文字：',
      '```action',
      '{"skill":"技能名","args":{"参数名":"参数值"}}',
      '```',
      '系统会执行该技能，并以「观察」把结果返回给你，你再据此继续；得到足够信息后用中文给出最终答复（最终答复里不要再写动作块）。',
      '',
      '【红线·必须遵守】',
      '1) 绝不编造赔率/比分/出线/数据。未知就先用 read_view / find_on_page / get_update_status 读取页面；页面也没有就如实说"暂无数据/待更新"。',
      '2) 一切时间按北京时间。',
      '3) 凡涉及投注建议，结尾必须附一句"理性娱乐，未成年人禁止购彩"。',
      '4) 你只做导航/查询/解读，不替用户下单或修改投注单。'
    ].join('\n');
  }

  /* ============ LLM Provider ============ */
  function extractText(r){
    if(r==null) return '';
    if(typeof r==='string') return r;
    if(typeof r.text==='string') return r.text;
    if(r.message){ var c=r.message.content; if(typeof c==='string') return c;
      if(Array.isArray(c)) return c.map(function(x){return x.text||x.content||'';}).join(''); }
    if(r.choices && r.choices[0] && r.choices[0].message) return r.choices[0].message.content||'';
    try{ return String(r); }catch(e){ return ''; }
  }

  // —— Puter.js（默认，免Key）——
  var puterLoading=null;
  function ensurePuter(){
    if(window.puter && window.puter.ai) return Promise.resolve();
    if(puterLoading) return puterLoading;
    puterLoading=new Promise(function(resolve,reject){
      var s=document.createElement('script'); s.src='https://js.puter.com/v2/';
      s.onload=function(){ resolve(); }; s.onerror=function(){ reject(new Error('Puter.js 加载失败：请检查网络是否能访问 js.puter.com，或在设置里改用 GLM 官方 Key。')); };
      document.head.appendChild(s);
    });
    return puterLoading;
  }
  async function callPuter(messages, cb){
    await ensurePuter();
    var full='', resp;
    try{ resp = await window.puter.ai.chat(messages, {model:CFG.puterModel, stream:true}); }
    catch(e){ // 兜底：扁平化为单条提示再试
      var prompt = messages.map(function(m){ return (m.role==='system'?'[系统]':m.role==='user'?'[用户]':'[助手]')+' '+m.content; }).join('\n\n');
      resp = await window.puter.ai.chat(prompt, {model:CFG.puterModel, stream:true});
    }
    try{
      for await (var part of resp){
        var t = part && (part.text!=null ? part.text : (part.message && part.message.content));
        if(typeof t==='string' && t){ full+=t; cb&&cb(full); }
      }
    }catch(e){ /* 某些版本非可迭代 */ }
    if(!full){ var r=await window.puter.ai.chat(messages,{model:CFG.puterModel}); full=extractText(r); cb&&cb(full); }
    return full;
  }

  // —— GLM 官方(bigmodel.cn)——
  async function callGLM(messages, cb){
    if(!CFG.glmKey) throw new Error('未配置 GLM API Key。请在「设置」填入（bigmodel.cn 免费注册即可获取），或切回 Puter 免Key模式。');
    var res;
    try{
      res = await fetch(CFG.glmBase, { method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+CFG.glmKey },
        body: JSON.stringify({ model:CFG.glmModel, messages:messages, temperature:CFG.temperature, stream:true }) });
    }catch(e){ throw new Error('GLM 请求失败：'+(e.message||e)+'。若是浏览器跨域(CORS)拦截，请用 Puter 模式，或参见使用说明用本地代理转发。'); }
    if(!res.ok){ var et=await res.text().catch(function(){return'';}); throw new Error('GLM 调用失败 '+res.status+'：'+et.slice(0,200)); }
    var reader=res.body.getReader(), dec=new TextDecoder(), buf='', full='';
    while(true){ var rd=await reader.read(); if(rd.done) break; buf+=dec.decode(rd.value,{stream:true});
      var idx; while((idx=buf.indexOf('\n'))>=0){ var line=buf.slice(0,idx).trim(); buf=buf.slice(idx+1);
        if(line.indexOf('data:')!==0) continue; var data=line.slice(5).trim(); if(data==='[DONE]') continue;
        try{ var j=JSON.parse(data); var d=j.choices&&j.choices[0]&&j.choices[0].delta&&j.choices[0].delta.content; if(d){ full+=d; cb&&cb(full); } }catch(e){}
      }
    }
    return full;
  }
  function callLLM(messages, cb){ return CFG.provider==='glm' ? callGLM(messages,cb) : callPuter(messages,cb); }

  /* ============ 动作解析 + Agent 回路 ============ */
  function tryJSON(s){ try{ return JSON.parse(String(s).trim()); }catch(e){ return null; } }
  function parseAction(text){
    if(!text) return null;
    var m=text.match(/```(?:action|json)\s*([\s\S]*?)```/i);
    if(m){ var o=tryJSON(m[1]); if(o&&o.skill) return o; }
    // 兜底：在 "skill" 附近做花括号配平扫描，正确处理嵌套 args
    var si=text.indexOf('"skill"'); if(si<0) return null;
    var start=text.lastIndexOf('{', si); if(start<0) return null;
    var depth=0;
    for(var k=start;k<text.length;k++){ var ch=text[k];
      if(ch==='{') depth++;
      else if(ch==='}'){ depth--; if(depth===0){ var o2=tryJSON(text.slice(start,k+1)); return (o2&&o2.skill)? o2 : null; } }
    }
    return null;
  }
  function stripAction(text){ return (text||'').replace(/```(?:action|json)\s*[\s\S]*?```/ig,'').trim(); }

  async function agentTurn(userText){
    HISTORY.push({role:'user', content:userText});
    var msgs=[{role:'system', content:sysPrompt()}].concat(HISTORY);
    var bubble=UI.addBot();
    var steps=0;
    while(steps++ < 6){
      var out='';
      try{
        out = await callLLM(msgs, function(t){
          if(CFG.autoAct && /```(?:action|json)/i.test(t)) bubble.status('正在准备操作…');
          else bubble.html(renderMD(t));
        });
      }catch(e){ bubble.html('⚠️ '+esc(e.message||e)); HISTORY.push({role:'assistant',content:'(调用出错)'}); return; }

      var action = CFG.autoAct ? parseAction(out) : null;
      if(action){
        msgs.push({role:'assistant', content:out});
        bubble.status('调用技能：'+esc(action.skill)+' …');
        var obs;
        try{ var sk=SKILLS.get(action.skill); obs = sk ? await sk.run(action.args||{}) : ('未知技能：'+action.skill+'。可用：'+Array.from(SKILLS.keys()).join(', ')); }
        catch(e){ obs='技能执行出错：'+(e.message||e); }
        obs=String(obs); if(obs.length>4000) obs=obs.slice(0,4000)+'…';
        msgs.push({role:'user', content:'【观察 · '+action.skill+'】\n'+obs});
        bubble.tool(action.skill, obs);
        continue;
      }
      var fin=stripAction(out)||out;
      bubble.html(renderMD(fin)); bubble.done();
      HISTORY.push({role:'assistant', content:out});
      return;
    }
    bubble.status('（已达最大操作步数，请补充提问）'); bubble.done();
  }

  /* ============ 极简 Markdown 渲染 ============ */
  function renderMD(t){
    if(!t) return '';
    var codes=[], i=0;
    t=t.replace(/```([\s\S]*?)```/g,function(_,c){ codes.push(c); return ' C'+(i++)+' '; });
    t=esc(t);
    t=t.replace(/`([^`]+)`/g,'<code>$1</code>');
    t=t.replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>');
    t=t.replace(/^#{1,6}\s*(.+)$/gm,'<b>$1</b>');
    t=t.replace(/^\s*[-*]\s+(.+)$/gm,'• $1');
    t=t.replace(/\n/g,'<br>');
    t=t.replace(/ C(\d+) /g,function(_,n){ return '<pre><code>'+esc(codes[n])+'</code></pre>'; });
    return t;
  }

  /* ============ 公共 API ============ */
  window.WCAgent = {
    version: '1.0',
    open: function(){ UI.open(); }, close: function(){ UI.close(); }, toggle: function(){ UI.toggle(); },
    ask: function(text){ UI.open(); UI.send(String(text||'')); },
    prefill: function(text){ UI.open(); UI.prefill(String(text||'')); },
    registerSkill: registerSkill, unregisterSkill: unregisterSkill,
    registerConnector: registerConnector, registerMCP: registerMCP,
    listSkills: function(){ return Array.from(SKILLS.values()).map(function(s){ return {name:s.name, description:s.description, source:s.source}; }); },
    getConfig: function(){ return Object.assign({}, CFG); },
    setConfig: function(p){ Object.assign(CFG, p||{}); saveCfg(); try{ syncSettingsUI(); }catch(e){} },
    clearHistory: function(){ HISTORY=[]; try{ UI.clearMsgs(); }catch(e){} }
  };

  /* ============ 界面 ============ */
  var STYLE = [
'#wcai-fab,#wcai-panel,#wcai-sel{position:fixed;z-index:2147483600;font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;-webkit-font-smoothing:antialiased}',
'#wcai-fab{right:20px;bottom:84px;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#C8A24B,#a6822f);color:#13203a;border:none;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;flex-direction:column;line-height:1;gap:2px;transition:transform .12s}',
'#wcai-fab:hover{transform:scale(1.07)}',
'#wcai-fab svg{width:20px;height:20px}',
'#wcai-sel{display:none;background:linear-gradient(135deg,#C8A24B,#a6822f);color:#13203a;border:none;border-radius:18px;padding:6px 12px;font-size:12.5px;font-weight:700;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.4)}',
'#wcai-panel{display:none;right:20px;bottom:84px;width:384px;max-width:calc(100vw - 28px);height:72vh;max-height:640px;background:#0f1830;border:1px solid #2b3a5a;border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.6);flex-direction:column;overflow:hidden;color:#e9eef6}',
'#wcai-panel.on{display:flex}',
'.wcai-hd{display:flex;align-items:center;gap:8px;padding:11px 13px;background:linear-gradient(135deg,#13203a,#0a1426);border-bottom:1px solid #2b3a5a}',
'.wcai-hd .t{font-weight:800;font-size:14px}.wcai-hd .m{color:#93a4c0;font-size:11px;margin-left:2px}',
'.wcai-hd .sp{flex:1}',
'.wcai-ic{background:rgba(255,255,255,.07);border:none;color:#cdd8ea;width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:15px}',
'.wcai-ic:hover{background:rgba(200,162,75,.25);color:#fff}',
'#wcai-msgs{flex:1;overflow:auto;padding:13px;display:flex;flex-direction:column;gap:11px}',
'.wcai-msg{max-width:88%;font-size:13.5px;line-height:1.62;word-break:break-word}',
'.wcai-msg.user{align-self:flex-end;background:#1d2d4f;border:1px solid #2b3a5a;color:#eaf0fb;padding:8px 11px;border-radius:12px 12px 3px 12px}',
'.wcai-msg.bot{align-self:flex-start;background:#15213a;border:1px solid #2b3a5a;padding:9px 12px;border-radius:12px 12px 12px 3px}',
'.wcai-msg.bot code{background:rgba(255,255,255,.09);padding:1px 5px;border-radius:5px;font-size:12px}',
'.wcai-msg.bot pre{background:#0a1426;border:1px solid #2b3a5a;border-radius:8px;padding:8px;overflow:auto;margin:6px 0}',
'.wcai-st{color:#93a4c0;font-size:12px;font-style:italic;margin-top:2px}',
'.wcai-tool{margin-top:6px;background:#0a1426;border:1px solid #243353;border-radius:8px;font-size:11.5px;color:#9fb3d6;overflow:hidden}',
'.wcai-tool summary{cursor:pointer;padding:5px 9px;color:#C8A24B;font-weight:700;list-style:none}',
'.wcai-tool div{padding:6px 9px;border-top:1px solid #243353;white-space:pre-wrap;max-height:160px;overflow:auto;color:#aebbd4}',
'.wcai-foot{padding:9px 12px;border-top:1px solid #2b3a5a;background:#0c1322}',
'.wcai-inrow{display:flex;gap:7px;align-items:flex-end}',
'#wcai-in{flex:1;resize:none;background:#15213a;border:1px solid #2b3a5a;border-radius:10px;color:#e9eef6;padding:8px 10px;font-size:13px;max-height:96px;font-family:inherit}',
'#wcai-in:focus{outline:none;border-color:#C8A24B}',
'#wcai-send{background:linear-gradient(135deg,#C8A24B,#a6822f);color:#13203a;border:none;border-radius:10px;padding:0 14px;height:38px;font-weight:800;cursor:pointer;font-size:13px}',
'#wcai-send:disabled{opacity:.5;cursor:default}',
'.wcai-disc{color:#ff9a8d;font-size:10.5px;margin-top:7px;text-align:center}',
'.wcai-quick{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}',
'.wcai-quick button{background:rgba(255,255,255,.05);border:1px solid #2b3a5a;color:#cdd8ea;border-radius:14px;padding:4px 10px;font-size:11.5px;cursor:pointer}',
'.wcai-quick button:hover{border-color:#C8A24B;color:#fff}',
'#wcai-set{display:none;position:absolute;inset:0;background:#0f1830;z-index:5;flex-direction:column}',
'#wcai-set.on{display:flex}',
'.wcai-setbody{flex:1;overflow:auto;padding:14px;font-size:13px}',
'.wcai-setbody label{display:block;color:#93a4c0;font-size:11.5px;margin:11px 0 4px}',
'.wcai-setbody input,.wcai-setbody select{width:100%;background:#15213a;border:1px solid #2b3a5a;border-radius:8px;color:#e9eef6;padding:7px 9px;font-size:13px;font-family:inherit}',
'.wcai-radio{display:flex;gap:8px;margin-top:4px}.wcai-radio button{flex:1;background:#15213a;border:1px solid #2b3a5a;color:#cdd8ea;border-radius:8px;padding:8px;cursor:pointer;font-size:12.5px}',
'.wcai-radio button.on{background:rgba(200,162,75,.22);border-color:#C8A24B;color:#fff;font-weight:700}',
'.wcai-skill{background:#15213a;border:1px solid #243353;border-radius:8px;padding:6px 9px;margin-top:6px;font-size:12px}',
'.wcai-skill b{color:#C8A24B}.wcai-skill .src{float:right;color:#7f93b6;font-size:10px}',
'.wcai-hint{color:#7f93b6;font-size:11px;line-height:1.6;margin-top:6px}',
'.wcai-hl{outline:3px solid #C8A24B !important;outline-offset:2px;border-radius:4px;transition:outline .2s}',
'@media(max-width:480px){#wcai-panel{right:8px;left:8px;width:auto;bottom:78px;height:78vh}#wcai-fab{right:14px;bottom:74px}}'
  ].join('\n');

  var els={};
  function build(){
    var st=document.createElement('style'); st.id='wcai-style'; st.textContent=STYLE; document.head.appendChild(st);

    var fab=document.createElement('button'); fab.id='wcai-fab'; fab.title='世界杯AI助手';
    fab.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/><circle cx="18" cy="18" r="3"/></svg><span>AI</span>';
    document.body.appendChild(fab);

    var sel=document.createElement('button'); sel.id='wcai-sel'; sel.innerHTML='✦ 问AI'; document.body.appendChild(sel);

    var p=document.createElement('div'); p.id='wcai-panel';
    p.innerHTML=
      '<div class="wcai-hd"><span class="t">世界杯AI助手</span><span class="m" id="wcai-modtag"></span><span class="sp"></span>'+
        '<button class="wcai-ic" id="wcai-new" title="新对话">⟲</button>'+
        '<button class="wcai-ic" id="wcai-gear" title="设置">⚙</button>'+
        '<button class="wcai-ic" id="wcai-x" title="关闭">✕</button></div>'+
      '<div id="wcai-msgs"></div>'+
      '<div class="wcai-foot">'+
        '<div class="wcai-quick">'+
          '<button data-q="这个页面现在显示了什么？">页面有什么</button>'+
          '<button data-q="现在有哪些可以投注的比赛？切到竞猜投注页看一下">可投注比赛</button>'+
          '<button data-q="读取顶部更新状态，告诉我最近一次更新了什么">最近更新</button>'+
        '</div>'+
        '<div class="wcai-inrow"><textarea id="wcai-in" rows="1" placeholder="问我世界杯竞猜，或让我操作页面…"></textarea><button id="wcai-send">发送</button></div>'+
        '<div class="wcai-disc">本助手仅供信息参考 · 理性娱乐，未成年人禁止购彩</div>'+
      '</div>'+
      '<div id="wcai-set"><div class="wcai-hd"><span class="t">设置</span><span class="sp"></span><button class="wcai-ic" id="wcai-setback">←</button></div>'+
        '<div class="wcai-setbody">'+
          '<label>模型来源 Provider</label>'+
          '<div class="wcai-radio"><button data-p="puter">Puter（免Key·推荐）</button><button data-p="glm">GLM 官方（自备Key）</button></div>'+
          '<div id="wcai-puterbox"><label>Puter 模型</label>'+
            '<select id="wcai-pm"><option value="z-ai/glm-4.7-flash">z-ai/glm-4.7-flash（免费·快）</option><option value="z-ai/glm-5.1">z-ai/glm-5.1（更强）</option><option value="z-ai/glm-5">z-ai/glm-5</option><option value="z-ai/glm-4.7">z-ai/glm-4.7</option></select>'+
            '<div class="wcai-hint">Puter 采用 user-pays 模式：浏览器原生、免后端、免 API Key，自动处理跨域。首次使用可能弹出 Puter 登录。</div></div>'+
          '<div id="wcai-glmbox" style="display:none"><label>GLM 模型</label>'+
            '<select id="wcai-gm"><option value="glm-4.7-flash">glm-4.7-flash（免费）</option><option value="glm-5.1">glm-5.1</option><option value="glm-5">glm-5</option><option value="glm-4.5-flash">glm-4.5-flash（免费）</option></select>'+
            '<label>API Key（Bearer）</label><input id="wcai-key" type="password" placeholder="在 bigmodel.cn 免费注册获取" autocomplete="off">'+
            '<div class="wcai-hint">免费 Key：bigmodel.cn 注册 → API Keys 创建。⚠ 浏览器直连可能被 CORS 拦截；若失败请改用 Puter，或用使用说明里的本地代理。Key 仅存于本机 localStorage。</div></div>'+
          '<label style="margin-top:14px">允许执行页面操作（导航/读取/查找）</label>'+
          '<div class="wcai-radio"><button data-act="1">开启</button><button data-act="0">关闭</button></div>'+
          '<label style="margin-top:14px">已注册技能 / 连接器 / MCP</label><div id="wcai-skills"></div>'+
          '<div class="wcai-hint" style="margin-top:8px">扩展：控制台调用 <code>WCAgent.registerSkill</code> / <code>registerConnector</code> / <code>registerMCP</code> 即可热添加，详见使用说明。</div>'+
        '</div></div>';
    document.body.appendChild(p);
    els={fab:fab, sel:sel, panel:p, msgs:p.querySelector('#wcai-msgs'), input:p.querySelector('#wcai-in'),
         send:p.querySelector('#wcai-send'), set:p.querySelector('#wcai-set'), modtag:p.querySelector('#wcai-modtag')};

    // 事件
    var moved=false, sx=0, sy=0;
    fab.addEventListener('pointerdown',function(e){ moved=false; sx=e.clientX; sy=e.clientY; });
    fab.addEventListener('pointerup',function(e){ if(Math.abs(e.clientX-sx)+Math.abs(e.clientY-sy)<6) UI.toggle(); });
    p.querySelector('#wcai-x').onclick=UI.close;
    p.querySelector('#wcai-gear').onclick=function(){ els.set.classList.add('on'); syncSettingsUI(); };
    p.querySelector('#wcai-setback').onclick=function(){ els.set.classList.remove('on'); };
    p.querySelector('#wcai-new').onclick=function(){ HISTORY=[]; UI.clearMsgs(); UI.greet(); };
    els.send.onclick=function(){ var v=els.input.value.trim(); if(v){ els.input.value=''; autosize(); UI.send(v); } };
    els.input.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); els.send.onclick(); } });
    els.input.addEventListener('input', autosize);
    p.querySelectorAll('.wcai-quick button').forEach(function(b){ b.onclick=function(){ UI.send(b.getAttribute('data-q')); }; });
    sel.addEventListener('click',function(){ var s=String(window.getSelection?window.getSelection():'').trim(); sel.style.display='none'; if(s){ UI.open(); UI.prefill(s); try{window.getSelection&&window.getSelection().removeAllRanges();}catch(e){} } });

    // 设置交互
    p.querySelectorAll('.wcai-radio [data-p]').forEach(function(b){ b.onclick=function(){ CFG.provider=b.getAttribute('data-p'); saveCfg(); syncSettingsUI(); updModtag(); }; });
    p.querySelectorAll('.wcai-radio [data-act]').forEach(function(b){ b.onclick=function(){ CFG.autoAct=b.getAttribute('data-act')==='1'; saveCfg(); syncSettingsUI(); }; });
    p.querySelector('#wcai-pm').onchange=function(e){ CFG.puterModel=e.target.value; saveCfg(); updModtag(); };
    p.querySelector('#wcai-gm').onchange=function(e){ CFG.glmModel=e.target.value; saveCfg(); updModtag(); };
    p.querySelector('#wcai-key').oninput=function(e){ CFG.glmKey=e.target.value.trim(); saveCfg(); };

    // 选中文本唤起
    document.addEventListener('mouseup',function(e){
      if(els.panel.contains(e.target)||e.target===sel) return;
      setTimeout(function(){
        var s=window.getSelection(); var txt=String(s||'').trim();
        if(txt && txt.length>=1 && txt.length<2000){
          try{ var rg=s.getRangeAt(0).getBoundingClientRect();
            sel.style.left=Math.max(8,Math.min(window.innerWidth-90, rg.left+rg.width/2-40))+'px';
            sel.style.top=Math.max(8, rg.top-40)+'px'; sel.style.display='block';
          }catch(err){ sel.style.display='none'; }
        } else sel.style.display='none';
      },10);
    });
    document.addEventListener('mousedown',function(e){ if(e.target!==sel) sel.style.display='none'; });

    updModtag(); renderSkillList();
  }
  function autosize(){ var t=els.input; t.style.height='auto'; t.style.height=Math.min(96,t.scrollHeight)+'px'; }
  function updModtag(){ if(els.modtag) els.modtag.textContent='· '+(CFG.provider==='glm'?CFG.glmModel:CFG.puterModel); }
  function syncSettingsUI(){ var p=els.panel; if(!p) return;
    p.querySelectorAll('.wcai-radio [data-p]').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-p')===CFG.provider); });
    p.querySelectorAll('.wcai-radio [data-act]').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-act')===(CFG.autoAct?'1':'0')); });
    p.querySelector('#wcai-puterbox').style.display = CFG.provider==='puter'?'block':'none';
    p.querySelector('#wcai-glmbox').style.display = CFG.provider==='glm'?'block':'none';
    p.querySelector('#wcai-pm').value=CFG.puterModel; p.querySelector('#wcai-gm').value=CFG.glmModel; p.querySelector('#wcai-key').value=CFG.glmKey;
  }
  function renderSkillList(){ var box=document.getElementById('wcai-skills'); if(!box) return; var h='';
    SKILLS.forEach(function(s){ h+='<div class="wcai-skill"><span class="src">'+esc(s.source)+'</span><b>'+esc(s.name)+'</b><br>'+esc(s.description)+'</div>'; });
    box.innerHTML=h; }

  function scrollBottom(){ if(els.msgs) els.msgs.scrollTop=els.msgs.scrollHeight; }

  var UI={
    open:function(){ if(!els.panel) return; els.panel.classList.add('on'); if(!els.msgs.children.length) UI.greet(); setTimeout(function(){els.input&&els.input.focus();},50); scrollBottom(); },
    close:function(){ els.panel&&els.panel.classList.remove('on'); },
    toggle:function(){ els.panel&&(els.panel.classList.contains('on')?UI.close():UI.open()); },
    clearMsgs:function(){ if(els.msgs) els.msgs.innerHTML=''; },
    greet:function(){ var d=document.createElement('div'); d.className='wcai-msg bot';
      d.innerHTML='你好！我是<b>世界杯竞猜助手</b>（'+(CFG.provider==='glm'?'GLM 官方':'Puter·GLM')+'）。<br>可以问我赛程/赔率/出线分析，或让我帮你<b>切换标签、查找比赛、读取页面</b>。<br>也可在页面上<b>选中文字</b>后点「✦ 问AI」。';
      els.msgs.appendChild(d); scrollBottom(); },
    prefill:function(t){ if(els.input){ els.input.value=t; autosize(); els.input.focus(); } },
    addUser:function(t){ var d=document.createElement('div'); d.className='wcai-msg user'; d.textContent=t; els.msgs.appendChild(d); scrollBottom(); },
    addBot:function(){ var wrap=document.createElement('div'); wrap.className='wcai-msg bot';
      var c=document.createElement('div'); var st=document.createElement('div'); st.className='wcai-st'; st.textContent='思考中…';
      wrap.appendChild(c); wrap.appendChild(st); els.msgs.appendChild(wrap); scrollBottom();
      return { html:function(s){ c.innerHTML=s; st.style.display='none'; scrollBottom(); },
        status:function(s){ st.style.display='block'; st.textContent=s; scrollBottom(); },
        tool:function(name,obs){ var dt=document.createElement('details'); dt.className='wcai-tool';
          dt.innerHTML='<summary>🔧 已执行：'+esc(name)+'</summary><div>'+esc(obs.slice(0,1200))+'</div>'; wrap.appendChild(dt); scrollBottom(); },
        done:function(){ st.style.display='none'; } }; },
    send:function(t){ t=String(t||'').trim(); if(!t) return; els.set&&els.set.classList.remove('on'); UI.addUser(t); agentTurn(t); }
  };

  function init(){ build(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();

})();
