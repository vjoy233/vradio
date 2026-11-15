/* 当前UI方案§4.1平面文字配对复核，零依赖；不代表透明叠加/全部组件/整页合规。
   node docs/ui-redesign-assets/contrast-check-v2.js */
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const doc=fs.readFileSync(path.join(__dirname,'../ui-redesign-plan-2026-11.md'),'utf8');
const tokens={};for(const m of doc.matchAll(/^\| (--ui-[\w-]+) \| (#[\da-f]{6}) \| (#[\da-f]{6}) \|/gmi))tokens[m[1]]={dark:m[2],light:m[3]};
const lum=hex=>{const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b;};
const ratio=(fg,bg)=>{const a=lum(fg),b=lum(bg);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
const pairs=[];for(const fg of ['text','muted','accent'])for(const bg of ['bg','surface','raised'])pairs.push([fg,bg]);pairs.push(['on-accent','accent'],['favorite','surface'],['danger','surface']);
const results=[];for(const theme of ['dark','light'])for(const [fg,bg]of pairs){assert(tokens['--ui-'+fg]&&tokens['--ui-'+bg],'token表缺少必要字段');const foreground=tokens['--ui-'+fg][theme],background=tokens['--ui-'+bg][theme],contrast=ratio(foreground,background);results.push({theme,pair:fg+'/'+bg,foreground,background,ratio:+contrast.toFixed(4),threshold:4.5,pass:contrast>=4.5});}
const failed=results.filter(r=>!r.pass),lowest=results.reduce((a,b)=>a.ratio<b.ratio?a:b);
const report={checkedAt:new Date().toISOString(),source:'docs/ui-redesign-plan-2026-11.md §4.1',scope:'24组不透明平面文字配对；不包含line、透明叠加、outline、focus、disabled、demo实际CSS及整页合规',result:failed.length?'FAIL':'PASS',lowest,results};
if(process.argv.includes('--write'))fs.writeFileSync(path.join(__dirname,'review-v22/contrast-results.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));if(failed.length)process.exitCode=1;