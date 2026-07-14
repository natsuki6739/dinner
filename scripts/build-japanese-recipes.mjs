import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const TARGET = 500;
const MAX_CHECKS = 6000;
const BATCH = 80;
const CONCURRENCY = 8;
const UA = 'KinnmeshiRecipeVerifier/4.1 (+https://github.com/natsuki6739/dinner)';
const ARCHIVE_COMMIT = '9057cd01089811151fb3b6f710d33d745bf6f47c';
const ARCHIVE = `https://raw.githubusercontent.com/qiuyueluzi/recipeApp/${ARCHIVE_COMMIT}/data_file`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const clean = v => String(v ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
const jp = /[ぁ-んァ-ヶ一-龠々]/;
const dessert = /ケーキ|クッキー|プリン|ゼリー|タルト|パイ|アイス|シャーベット|ムース|ドーナツ|ドリンク|ジュース|スムージー|ジャム|シロップ|デザート|菓子|パンケーキ|クレープ|パフェ|あんみつ|羊羹|大福|ぜんざい|おしるこ|スイーツ/i;
const errorPage = /404|ページが見つかりません|お探しのページ|not found|指定されたページ|エラーが発生/i;

const SOURCES = [
  {
    key:'kikkoman', label:'キッコーマン ホームクッキング', domain:'kikkoman.co.jp', origin:'https://www.kikkoman.co.jp',
    pattern:/^https:\/\/(?:www\.)?kikkoman\.co\.jp\/homecook\/search\/recipe\/\d{8}\/(?:index\.html)?(?:[?#].*)?$/i,
    sitemaps:['https://www.kikkoman.co.jp/sitemap.xml','https://www.kikkoman.co.jp/sitemap_index.xml','https://www.kikkoman.co.jp/homecook/sitemap.xml'],
    archive:'kikkoman', id:/^3\d{7}$/, fromId:id=>`https://www.kikkoman.co.jp/homecook/search/recipe/0${id.slice(1)}/index.html`
  },
  {
    key:'kewpie', label:'キユーピー とっておきレシピ', domain:'kewpie.co.jp', origin:'https://www.kewpie.co.jp',
    pattern:/^https:\/\/(?:www\.)?kewpie\.co\.jp\/recipes\/recipe\/QP\d+\/(?:[?#].*)?$/i,
    sitemaps:['https://www.kewpie.co.jp/sitemap.xml','https://www.kewpie.co.jp/sitemap_index.xml','https://www.kewpie.co.jp/recipes/sitemap.xml'],
    archive:'kewpie', id:/^1\d{7}$/, fromId:id=>`https://www.kewpie.co.jp/recipes/recipe/QP${id}/`
  },
  {
    key:'ajinomoto', label:'味の素パーク', domain:'park.ajinomoto.co.jp', origin:'https://park.ajinomoto.co.jp',
    pattern:/^https:\/\/park\.ajinomoto\.co\.jp\/recipe\/card\/\d+\/(?:[?#].*)?$/i,
    sitemaps:['https://park.ajinomoto.co.jp/sitemap.xml','https://park.ajinomoto.co.jp/sitemap_index.xml','https://park.ajinomoto.co.jp/recipe-sitemap.xml','https://park.ajinomoto.co.jp/wp-sitemap.xml'],
    archive:'ajinomoto', id:/^2\d{7}$/, fromId:id=>`https://park.ajinomoto.co.jp/recipe/card/${id.slice(-6)}/`
  },
  {
    key:'mizkan', label:'ミツカン おうちレシピ', domain:'mizkan.co.jp', origin:'https://www.mizkan.co.jp',
    pattern:/^https:\/\/(?:www\.)?mizkan\.co\.jp\/ouchirecipe\/recipe\/(?:index\.html)?\?[^#]*menu_id=\d+/i,
    sitemaps:['https://www.mizkan.co.jp/sitemap.xml','https://www.mizkan.co.jp/sitemap_index.xml','https://www.mizkan.co.jp/ouchirecipe/sitemap.xml'],
    archive:'mizkan', id:/^4\d{7}$/, fromId:id=>`https://www.mizkan.co.jp/ouchirecipe/recipe/?menu_id=${id.slice(-6)}`
  }
];

const proteinRules = [
  [/鶏むね|鶏胸|ささみ/g,14,'鶏むね肉・ささみ'], [/鶏もも|鶏肉|鶏ひき|手羽|鶏レバー|チキン/g,10,'鶏肉'],
  [/豚ヒレ/g,14,'豚ヒレ肉'], [/豚肉|豚ロース|豚もも|豚ひき|豚こま|豚バラ|ポーク/g,10,'豚肉'],
  [/牛肉|牛ひき|牛もも|牛ロース|牛すじ|ビーフ/g,10,'牛肉'],
  [/かつお|まぐろ|鮭|さけ|サーモン|さば|あじ|いわし|ぶり|たら|かじき|たい|ツナ|魚/g,10,'魚'],
  [/えび|海老|いか|たこ|かに|帆立|ほたて|あさり|しじみ|牡蠣|かき|貝/g,9,'魚介'],
  [/卵|たまご|玉子/g,6,'卵'], [/豆腐|厚揚げ|油揚げ|高野豆腐/g,8,'豆腐・大豆製品'],
  [/納豆|大豆|おから|豆乳|テンペ/g,8,'大豆製品'], [/ひよこ豆|レンズ豆|ミックスビーンズ|いんげん豆|豆(?!板醤)/g,6,'豆類'],
  [/ヨーグルト|チーズ|牛乳/g,3,'乳製品'], [/ハム|ベーコン|ソーセージ|ウインナー/g,5,'肉加工品'],
  [/ちくわ|かまぼこ|はんぺん|しらす|桜えび/g,5,'魚肉・小魚']
];
const lean = /鶏むね|鶏胸|ささみ|豚ヒレ|かつお|まぐろ|鮭|さけ|サーモン|さば|あじ|いわし|たら|かじき|えび|いか|たこ|豆腐|納豆|大豆|しらす/;

function decode(v){return String(v??'').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));}
function strip(v){return clean(decode(String(v??'').replace(/<!--[\s\S]*?-->/g,' ').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ')));}
function normUrl(v){try{const u=new URL(decode(clean(v)));u.hash='';for(const k of [...u.searchParams.keys()])if(/^(utm_|fbclid|gclid|yclid)/i.test(k))u.searchParams.delete(k);return u.toString();}catch{return '';}}
function normName(v){return clean(strip(v)).replace(/\s*[｜|].*$/g,'').replace(/のレシピ(?:・作り方)?(?:です)?$/g,'').replace(/レシピ・作り方.*$/g,'').replace(/作り方.*$/g,'').trim();}
function keyName(v){return clean(v).replace(/[\s　!！?？・:：()（）【】\[\]「」『』,，。\-ー\/]/g,'').toLowerCase();}
function hash(v){let h=2166136261;for(let i=0;i<v.length;i++){h^=v.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function sourceFor(url){return SOURCES.find(s=>s.pattern.test(url))||null;}
function protein(name,ingredients){const t=`${name} ${ingredients.join(' ')}`;let score=0;const foods=[];for(const[r,p,l]of proteinRules){r.lastIndex=0;const m=t.match(r);if(m?.length){score+=p+Math.min(m.length-1,3);if(!foods.includes(l))foods.push(l);}}return{score,foods,lean:lean.test(t)};}

async function get(url,attempts=3,timeout=25000){let err;for(let i=1;i<=attempts;i++){try{const r=await fetch(url,{redirect:'follow',headers:{'user-agent':UA,'accept-language':'ja,en;q=0.5',accept:'text/html,application/xhtml+xml,application/xml,text/xml,application/json,text/plain,*/*'},signal:AbortSignal.timeout(timeout)});if(!r.ok){err=new Error(`HTTP ${r.status}: ${url}`);if(![408,425,429,500,502,503,504].includes(r.status))break;await wait(i*1200);continue;}let b=Buffer.from(await r.arrayBuffer());if(/\.gz(?:$|\?)/i.test(url)||/gzip/i.test(r.headers.get('content-type')||'')){try{b=gunzipSync(b);}catch{}}return{text:b.toString('utf8'),response:r};}catch(e){err=e;await wait(i*1200);}}throw err||new Error(`取得失敗: ${url}`);}

function xmlLocs(xml){return [...String(xml).matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)].map(m=>normUrl(strip(m[1]))).filter(Boolean);}
async function sitemapSeeds(s){const q=[...new Set([...s.sitemaps,`${s.origin}/sitemap.xml`,`${s.origin}/sitemap_index.xml`,`${s.origin}/wp-sitemap.xml`])];const seen=new Set(),urls=new Set();while(q.length&&seen.size<240){const u=q.shift();if(!u||seen.has(u))continue;seen.add(u);try{const{text}=await get(u,2,30000);const locs=xmlLocs(text);const index=/<sitemapindex\b/i.test(text)||locs.every(x=>/sitemap|\.xml(?:\.gz)?(?:$|[?#])/i.test(x));for(const x of locs){if(s.pattern.test(x))urls.add(x);else if(index&&/sitemap|\.xml(?:\.gz)?(?:$|[?#])/i.test(x)&&!seen.has(x))q.push(x);}}catch{}}console.log(`${s.label}: サイトマップ由来 ${urls.size}件`);return urls;}
function parseId(line){const i=line.indexOf(',');return clean(i>=0?line.slice(0,i):line);}
async function archiveSeeds(s){const urls=new Set();try{const[{text:ings},{text:recipes}]=await Promise.all([get(`${ARCHIVE}/${s.archive}/ingredients.csv`,3,60000),get(`${ARCHIVE}/${s.archive}/recipes.csv`,3,60000).catch(()=>({text:''}))]);for(const line of ings.split(/\r?\n/)){const id=parseId(line);if(s.id.test(id))urls.add(s.fromId(id));}for(const line of recipes.split(/\r?\n/)){const u=normUrl(line.split(',').at(-1));if(u&&s.pattern.test(u))urls.add(u);}}catch{}console.log(`${s.label}: URL補助索引 ${urls.size}件`);return urls;}
async function discover(s){const[sm,ar]=await Promise.all([sitemapSeeds(s),archiveSeeds(s)]);const urls=[...new Set([...sm,...ar].map(normUrl).filter(u=>s.pattern.test(u)))].sort((a,b)=>hash(a)-hash(b));console.log(`${s.label}: 確認候補 ${urls.length}件`);return urls.map(url=>({source:s,url}));}
function roundRobin(groups){const out=[];let i=0;while(groups.some(g=>i<g.length)){for(const g of groups)if(i<g.length)out.push(g[i]);i++;}return out;}

function flatten(v,o=[]){if(Array.isArray(v))v.forEach(x=>flatten(x,o));else if(v&&typeof v==='object'){o.push(v);if(v['@graph'])flatten(v['@graph'],o);if(v.itemListElement)flatten(v.itemListElement,o);}return o;}
function parseJson(raw){for(const x of [decode(clean(raw)),decode(clean(raw)).replace(/[\u0000-\u001f]+/g,' ')])try{return JSON.parse(x);}catch{}return null;}
function recipeLd(html){for(const m of String(html).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){const p=parseJson(m[1]);if(!p)continue;const r=flatten(p).find(x=>{const t=x?.['@type'];return t==='Recipe'||(Array.isArray(t)&&t.includes('Recipe'));});if(r)return r;}return null;}
function instructions(v,o=[]){if(typeof v==='string')o.push(v);else if(Array.isArray(v))v.forEach(x=>instructions(x,o));else if(v&&typeof v==='object'){if(v.text)o.push(v.text);if(v.itemListElement)instructions(v.itemListElement,o);}return o;}
function pageName(html,ld){const n=normName(ld?.name||'');if(n&&jp.test(n))return n;const h=normName(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]||'');if(h&&jp.test(h))return h;const t=normName(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'');return t&&jp.test(t)?t:'';}
function ingredient(v){let x=clean(strip(v)).replace(/^キッコーマン\s*/i,'').replace(/^マンジョウ\s*/i,'').replace(/^デルモンテ[・\s]*/i,'').replace(/^味の素(?:KK)?\s*/i,'').replace(/^AJINOMOTO\s*/i,'').replace(/^キユーピー\s*/i,'').replace(/^ミツカン\s*/i,'').trim();return x&&jp.test(x)?x.slice(0,180):'';}
function step(v){const x=clean(strip(v)).replace(/※.*$/g,'');if(!x||!jp.test(x))return'';if(/切|薄切|細切|みじん切|乱切|くし形|拍子木|皮をむ|種を取|筋を取/.test(x))return'材料を洗い、元レシピで指定された大きさに切る。';if(/電子レンジ|レンジ|耐熱容器/.test(x))return'材料を耐熱容器に入れ、元レシピ指定の時間レンジで加熱する。';if(/下味|漬け|マリネ|なじませ|置いてお/.test(x))return'材料に調味料をなじませ、元レシピ指定の時間休ませる。';if(/揚げ|油で.*熱/.test(x))return'油を適温に熱し、材料に火が通って色づくまで揚げる。';if(/炒め|炒る/.test(x))return'フライパンで材料を順に炒め、全体に火を通す。';if(/煮立|煮る|煮込|ゆで|茹で|沸騰/.test(x))return'鍋に材料と調味料を入れ、元レシピ指定の状態になるまで加熱する。';if(/オーブン|トースター|焼き色|焼く|焼い|グリル|ソテー/.test(x))return'加熱器具で表面を焼き、必要な材料は中心まで十分に火を通す。';if(/混ぜ|和え|からめ|合わせ|溶き|つぶ/.test(x))return'指定された材料と調味料を、全体が均一になるよう混ぜる。';if(/水気|水分|ざる|ザル|冷水/.test(x))return'材料の水分をよく切り、次の工程に備える。';if(/盛り|器に|仕上げ|添え|かける/.test(x))return'器に盛り、指定の調味料や付け合わせで仕上げる。';return'元レシピの順序に沿って材料を調理し、味を整える。';}
function steps(raw){const out=[];for(const x of raw){const y=step(x);if(y&&!out.includes(y))out.push(y);}return out.slice(0,7);}
function duration(v){const m=String(v||'').match(/^P(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?)?$/i);return m?Number(m[1]||0)*1440+Number(m[2]||0)*60+Number(m[3]||0)+Math.ceil(Number(m[4]||0)/60):null;}
function number(v){const m=String(v||'').match(/([0-9]+(?:\.[0-9]+)?)/);return m?Number(m[1]):null;}
async function verify(c){try{const{text:html,response}=await get(c.url,3,24000);const final=normUrl(response.url||c.url),s=sourceFor(final);if(!s||s.key!==c.source.key)throw new Error('別ページへ転送');const ld=recipeLd(html),name=pageName(html,ld),ings=(Array.isArray(ld?.recipeIngredient)?ld.recipeIngredient:[]).map(ingredient).filter(Boolean),raw=instructions(ld?.recipeInstructions),st=steps(raw),visible=strip(html).slice(0,1200);if(!name||!jp.test(name))throw new Error('日本語名なし');if(dessert.test(name))throw new Error('デザート');if(errorPage.test(`${name} ${visible}`))throw new Error('エラーページ');if(ings.length<3)throw new Error(`材料${ings.length}件`);if(st.length<1)throw new Error('手順なし');return{ok:true,source:s,sourceUrl:final,checkedAt:new Date().toISOString(),pageStatus:response.status,name,ingredients:ings,steps:st,protein:protein(name,ings),timeMinutes:duration(ld?.totalTime||ld?.cookTime||ld?.prepTime),calories:number(ld?.nutrition?.calories),servings:number(Array.isArray(ld?.recipeYield)?ld.recipeYield[0]:ld?.recipeYield)};}catch(e){return{ok:false,url:c.url,source:c.source.label,reason:e instanceof Error?e.message:String(e)};}}
async function parallel(items,fn){const out=new Array(items.length);let n=0;async function run(){while(true){const i=n++;if(i>=items.length)return;out[i]=await fn(items[i]);await wait(250);}}await Promise.all(Array.from({length:CONCURRENCY},run));return out;}
function category(r){const f=r.protein.foods;if(f.some(x=>x.includes('鶏')))return'鶏肉料理';if(f.some(x=>x.includes('豚')))return'豚肉料理';if(f.some(x=>x.includes('牛')))return'牛肉料理';if(f.some(x=>x==='魚'||x==='魚介'||x.includes('魚肉')))return'魚介料理';if(f.includes('卵'))return'卵料理';if(f.some(x=>x.includes('豆')))return'豆・大豆料理';if(/ご飯|丼|うどん|そば|パスタ|麺/.test(r.name))return'主食';return'たんぱく質を含む料理';}
function select(records){const groups=SOURCES.map(s=>records.filter(r=>r.source.key===s.key).sort((a,b)=>b.protein.score-a.protein.score||a.name.localeCompare(b.name,'ja'))),out=[];let i=0;while(out.length<TARGET&&groups.some(g=>i<g.length)){for(const g of groups){if(out.length>=TARGET)break;if(i<g.length)out.push(g[i]);}i++;}return out;}

async function main(){
  console.log('公式サイトマップとURL索引から候補を集めます。古いCSVの料理内容は使いません。');
  const groups=[];for(const s of SOURCES)groups.push(await discover(s));
  const candidates=roundRobin(groups).slice(0,MAX_CHECKS);if(candidates.length<TARGET)throw new Error(`候補${candidates.length}件`);
  const valid=[],failures=[],seenU=new Set(),seenN=new Set();let checked=0;
  for(let off=0;off<candidates.length;off+=BATCH){const batch=candidates.slice(off,off+BATCH),res=await parallel(batch,verify);checked+=res.length;for(const r of res){if(!r.ok){failures.push(r);continue;}const u=r.sourceUrl.replace(/\/$/,''),n=keyName(r.name);if(seenU.has(u)||seenN.has(n))continue;seenU.add(u);seenN.add(n);valid.push(r);}const eligible=valid.filter(r=>r.protein.score>=4);console.log(`確認${checked}/${candidates.length} 有効${valid.length} 筋トレ候補${eligible.length}/${TARGET}`);await fs.writeFile('recipes-crawl-progress.json',JSON.stringify({updatedAt:new Date().toISOString(),checked,valid:valid.length,eligible:eligible.length,recentFailures:failures.slice(-100)},null,2)+'\n');if(checked>=1600&&eligible.length>=760)break;}
  const eligible=valid.filter(r=>r.protein.score>=4);if(eligible.length<TARGET){await fs.writeFile('recipes-validation-partial.json',JSON.stringify({generatedAt:new Date().toISOString(),checked,valid:valid.length,eligible:eligible.length,sourceCounts:Object.fromEntries(SOURCES.map(s=>[s.label,eligible.filter(r=>r.source.key===s.key).length])),failures:failures.slice(0,2000)},null,2)+'\n');throw new Error(`筋トレ候補${eligible.length}件`);}
  const chosen=select(eligible),recipes=chosen.map((r,i)=>{const goals=['maintain'];if(r.protein.score>=8)goals.push('muscle');if(r.protein.lean&&(r.calories===null||r.calories<=550))goals.push('cut');return{id:`jp-${r.source.key}-${String(i+1).padStart(4,'0')}`,name:r.name,category:category(r),area:'日本の家庭料理',tags:r.protein.foods,ingredients:r.ingredients,steps:r.steps,timeMinutes:r.timeMinutes,calories:r.calories,servings:r.servings,proteinScore:r.protein.score,proteinLabel:r.protein.score>=14?'かなり高め':r.protein.score>=8?'高め':'中程度',proteinFoods:r.protein.foods,goals:[...new Set(goals)],sourceName:r.source.label,sourceDomain:r.source.domain,sourceUrl:r.sourceUrl,checkedAt:r.checkedAt,pageStatus:r.pageStatus,dataOrigin:'現在の公開ページ'};});
  const report={generatedAt:new Date().toISOString(),targetCount:TARGET,outputCount:recipes.length,discoveryMethod:'公式サイトマップ＋現在URL候補',selectionMethod:'現在ページから料理名・材料・手順を取得後に判定',archivedRecipeContentUsed:false,pagesChecked:checked,validCurrentPages:valid.length,proteinEligible:eligible.length,sourceCounts:Object.fromEntries(SOURCES.map(s=>[s.label,recipes.filter(r=>r.sourceName===s.label).length])),records:recipes.map((r,i)=>({index:i+1,name:r.name,sourceName:r.sourceName,sourceUrl:r.sourceUrl,checkedAt:r.checkedAt,status:r.pageStatus})),failures:failures.slice(0,2000)};
  if(recipes.length!==TARGET)throw new Error(`出力${recipes.length}件`);if(new Set(recipes.map(r=>r.sourceUrl.replace(/\/$/,''))).size!==TARGET)throw new Error('URL重複');if(new Set(recipes.map(r=>keyName(r.name))).size!==TARGET)throw new Error('料理名重複');if(recipes.some(r=>!r.name||r.ingredients.length<3||r.steps.length<1||r.dataOrigin!=='現在の公開ページ'))throw new Error('必須項目不足');
  await fs.writeFile('recipes.json',JSON.stringify(recipes,null,2)+'\n');await fs.writeFile('recipes-validation.json',JSON.stringify(report,null,2)+'\n');console.log(`完了 ${recipes.length}件`);
}

export { xmlLocs, recipeLd, protein, steps, keyName };
if(process.env.KINNMESHI_SKIP_MAIN!=='1')main().catch(e=>{console.error(e);process.exitCode=1;});
