import * as cheerio from 'cheerio';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const hosts=process.argv.slice(2);
async function f(u:string){const c=new AbortController();const t=setTimeout(()=>c.abort(),15000);try{const r=await fetch(u,{signal:c.signal,redirect:'follow',headers:{'User-Agent':UA}});const h=await r.text();return{status:r.status,url:r.url,html:h};}catch(e){return{status:0,url:u,err:(e as Error).message};}finally{clearTimeout(t);}}
for(const host of hosts){
  const r:any=await f(`https://${host}/`);
  if(r.status>=400||!r.html){console.log(`${host}\tHOME ${r.status||r.err}`);continue;}
  const $=cheerio.load(r.html);const links:string[]=[];
  $('a[href]').each((_,el)=>{const tx=`${$(el).text()} ${$(el).attr('href')||''}`.toLowerCase();if(/問い?合|問合|contact|inquiry|toiawase|相談|見積|資料|お申/i.test(tx)){const h=$(el).attr('href')||'';try{const abs=new URL(h,r.url).toString();if(!links.includes(abs))links.push(abs);}catch{}}});
  console.log(`${host}\tHOME ${r.status} -> ${r.url}  contactLinks=${links.length}`);
  for(const l of links.slice(0,6))console.log('    '+l);
}
