import fs from 'node:fs/promises';

const TARGET = 500;
const SOURCE_COMMIT = '9057cd01089811151fb3b6f710d33d745bf6f47c';
const RAW_BASE = `https://raw.githubusercontent.com/qiuyueluzi/recipeApp/${SOURCE_COMMIT}/data_file`;
const MAX_PAGES = 6000;
const BATCH_SIZE = 120;
const CONCURRENCY = 8;

const SOURCES = [
  {
    key: 'kikkoman',
    label: 'キッコーマン ホームクッキング',
    domain: 'kikkoman.co.jp',
    idPattern: /^3\d{7}$/,
    urlFromId: id => `https://www.kikkoman.co.jp/homecook/search/recipe/${id.slice(1)}/index.html`,
  },
  {
    key: 'kewpie',
    label: 'キユーピー とっておきレシピ',
    domain: 'kewpie.co.jp',
    idPattern: /^1\d{7}$/,
    urlFromId: id => `https://www.kewpie.co.jp/recipes/recipe/QP${id}/`,
  },
  {
    key: 'ajinomoto',
    label: '味の素パーク',
    domain: 'park.ajinomoto.co.jp',
    idPattern: /^2\d{7}$/,
    urlFromId: id => `https://park.ajinomoto.co.jp/recipe/card/${id.slice(-6)}/`,
  },
  {
    key: 'mizkan',
    label: 'ミツカン おうちレシピ',
    domain: 'mizkan.co.jp',
    idPattern: /^4\d{7}$/,
    urlFromId: id => `https://www.mizkan.co.jp/ouchirecipe/recipe/?menu_id=${id.slice(-6)}`,
  },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = value => String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();

async function fetchText(url, { timeoutMs = 18000, attempts = 2 } = {}) {
  let lastError = new Error(`取得できませんでした: ${url}`);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; KinnmeshiRecipeVerifier/3.0; +https://github.com/natsuki6739/dinner)',
          'accept-language': 'ja,en;q=0.5',
          accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        return { text: await response.text(), response };
      }

      lastError = new Error(`HTTP ${response.status}: ${url}`);
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < attempts) await sleep(700 * attempt);
  }

  throw lastError;
}

function parseRecipeLine(line) {
  const parts = line.split(',');
  if (parts.length < 10) return null;
  const id = clean(parts[0]);
  const url = clean(parts.at(-1));
  const stepCount = Number(parts.at(-2));
  const ingredientCount = Number(parts.at(-3));
  const timeMinutes = Number(parts.at(-4));
  const servings = Number(parts.at(-5));
  const saltGrams = Number(parts.at(-6));
  const calories = Number(parts.at(-7));
  const name = clean(parts.slice(2, -7).join(','));
  if (!id) return null;
  return {
    id,
    name,
    url: /^https?:\/\//.test(url) ? url : '',
    stepCount,
    ingredientCount,
    timeMinutes,
    servings,
    saltGrams,
    calories,
  };
}

function parseIngredientLine(line) {
  const first = line.indexOf(',');
  const last = line.lastIndexOf(',');
  if (first < 1 || last <= first) return null;
  const id = clean(line.slice(0, first));
  const name = clean(line.slice(first + 1, last));
  const amount = clean(line.slice(last + 1));
  return id && name ? { id, name, amount } : null;
}

function parseStepLine(line) {
  const first = line.indexOf(',');
  const second = line.indexOf(',', first + 1);
  if (first < 1 || second <= first) return null;
  const id = clean(line.slice(0, first));
  const orderText = clean(line.slice(first + 1, second));
  const text = clean(line.slice(second + 1));
  if (!id || !text || text.startsWith('※')) return null;
  return {
    id,
    order: Number.isFinite(Number(orderText)) ? Number(orderText) : 999,
    text,
  };
}

function groupById(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    if (!map.has(row.id)) map.set(row.id, []);
    map.get(row.id).push(row);
  }
  return map;
}

const proteinPatterns = [
  [/鶏むね|鶏胸|ささみ/g, 12, '鶏むね肉・ささみ'],
  [/鶏もも|鶏肉|鶏ひき|手羽|鶏レバー/g, 9, '鶏肉'],
  [/豚ヒレ/g, 12, '豚ヒレ肉'],
  [/豚肉|豚ロース|豚もも|豚ひき|豚こま|豚バラ/g, 9, '豚肉'],
  [/牛肉|牛ひき|牛もも|牛ロース|牛すじ/g, 9, '牛肉'],
  [/かつお|まぐろ|鮭|さけ|さば|あじ|いわし|ぶり|たら|かじき|たい|魚/g, 9, '魚'],
  [/えび|海老|いか|たこ|かに|帆立|ほたて|あさり|しじみ/g, 8, '魚介'],
  [/卵|たまご/g, 5, '卵'],
  [/豆腐|厚揚げ|油揚げ|高野豆腐/g, 7, '豆腐・大豆製品'],
  [/納豆|大豆|おから|豆乳|テンペ/g, 7, '大豆製品'],
  [/ひよこ豆|レンズ豆|ミックスビーンズ|いんげん豆|豆(?!板醤)/g, 5, '豆類'],
  [/ヨーグルト|チーズ/g, 2, '乳製品'],
];

const leanPattern = /鶏むね|鶏胸|ささみ|豚ヒレ|かつお|まぐろ|鮭|さけ|さば|あじ|いわし|たら|かじき|えび|いか|たこ|豆腐|納豆|大豆/;
const dessertPattern = /ケーキ|クッキー|プリン|ゼリー|タルト|パイ|アイス|シャーベット|ムース|ドーナツ|ドリンク|ジュース|スムージー|ジャム|シロップ|デザート|菓子|パンケーキ|クレープ/;
const errorPagePattern = /404|ページが見つかりません|お探しのページ|not found|指定されたページ|エラーが発生/i;
const japanesePattern = /[ぁ-んァ-ヶ一-龠]/;

function proteinInfo(name, ingredients) {
  const text = `${name || ''} ${ingredients.map(item => item.name || item).join(' ')}`;
  let score = 0;
  const foods = [];

  for (const [pattern, points, label] of proteinPatterns) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches?.length) {
      score += points + Math.min(matches.length - 1, 2);
      if (!foods.includes(label)) foods.push(label);
    }
  }

  return { score, foods, lean: leanPattern.test(text) };
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripHtml(value) {
  return clean(decodeHtml(String(value ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')));
}

function flattenJsonLd(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, output);
  } else if (value && typeof value === 'object') {
    output.push(value);
    if (value['@graph']) flattenJsonLd(value['@graph'], output);
  }
  return output;
}

function extractRecipeJsonLd(html) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    const raw = decodeHtml(match[1]).trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const recipe = flattenJsonLd(parsed).find(item => {
        const type = item?.['@type'];
        return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
      });
      if (recipe) return recipe;
    } catch {
      // JSON-LDが壊れているページは、タイトル確認と保存済み公開データへフォールバックする。
    }
  }
  return null;
}

function jsonLdSteps(recipe) {
  const instructions = recipe?.recipeInstructions;
  if (!instructions) return [];
  const values = Array.isArray(instructions) ? instructions : [instructions];
  const output = [];

  const collect = item => {
    if (typeof item === 'string') output.push(item);
    else if (item?.text) output.push(item.text);
    else if (Array.isArray(item?.itemListElement)) item.itemListElement.forEach(collect);
  };

  values.forEach(collect);
  return output.map(clean).filter(Boolean);
}

function normalizeTitle(value) {
  return clean(stripHtml(value))
    .replace(/\s*[｜|].*$/g, '')
    .replace(/のレシピ(?:・作り方)?(?:です)?$/g, '')
    .replace(/レシピ・作り方.*$/g, '')
    .replace(/作り方.*$/g, '')
    .replace(/^[#＃]\s*/, '')
    .trim();
}

function extractPageName(html, ld) {
  const ldName = normalizeTitle(ld?.name || '');
  if (ldName && japanesePattern.test(ldName)) return ldName;

  const h1Match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Name = normalizeTitle(h1Match?.[1] || '');
  if (h1Name && japanesePattern.test(h1Name)) return h1Name;

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const titleName = normalizeTitle(titleMatch?.[1] || '');
  return titleName && japanesePattern.test(titleName) ? titleName : '';
}

function normalizedMatchText(value) {
  return clean(value).replace(/[\s　!！?？・:：()（）【】\[\]「」『』,，。\-ー]/g, '').toLowerCase();
}

function titleMatches(expected, actual) {
  if (!expected) return null;
  const left = normalizedMatchText(expected);
  const right = normalizedMatchText(actual);
  if (!left || !right) return false;
  const probe = left.slice(0, Math.min(left.length, 14));
  return probe.length >= 3 && right.includes(probe);
}

function normalizeIngredient(item) {
  const name = clean(item.name)
    .replace(/^キッコーマン/, '')
    .replace(/^マンジョウ/, '')
    .replace(/^デルモンテ・/, '')
    .replace(/^味の素KK/, '')
    .replace(/^「AJINOMOTO[^」]*」/, '')
    .trim();
  const amount = clean(item.amount);
  if (!name) return null;
  if (/^[<(（【].*[>）】)]$/.test(name) && (!amount || amount === '-')) return `【${name.replace(/[<>()（）【】]/g, '')}】`;
  return `${name}${amount && amount !== '-' ? `：${amount}` : ''}`;
}

function conciseStep(text) {
  const value = clean(text).replace(/※.*$/g, '');
  if (!value) return '';

  const has = pattern => pattern.test(value);
  if (has(/切|薄切|細切|みじん切|乱切|くし形|拍子木|皮をむ|種を取|筋を取/)) {
    return '材料を洗い、元レシピで指定された大きさに切る。';
  }
  if (has(/電子レンジ|レンジ|耐熱容器/)) {
    return '材料を耐熱容器に入れ、元レシピ指定の時間レンジで加熱する。';
  }
  if (has(/下味|漬け|マリネ|なじませ|置いてお/)) {
    return '材料に調味料をなじませ、元レシピ指定の時間休ませる。';
  }
  if (has(/揚げ|油で.*熱/)) {
    return '油を適温に熱し、材料に火が通って色づくまで揚げる。';
  }
  if (has(/炒め|炒る/)) {
    return 'フライパンで材料を順に炒め、全体に火を通す。';
  }
  if (has(/煮立|煮る|煮込|ゆで|茹で|沸騰/)) {
    return '鍋に材料と調味料を入れ、元レシピ指定の状態になるまで加熱する。';
  }
  if (has(/オーブン|トースター|焼き色|焼く|焼い|グリル|ソテー/)) {
    return '加熱器具で両面または表面を焼き、中心まで火を通す。';
  }
  if (has(/混ぜ|和え|からめ|合わせ|溶き|つぶ/)) {
    return '指定された材料と調味料を、全体が均一になるよう混ぜる。';
  }
  if (has(/水気|水分|ざる|ザル|冷水/)) {
    return '材料の水分をよく切り、次の工程に備える。';
  }
  if (has(/盛り|器に|添え|仕上げ|散ら/)) {
    return '器に盛り、仕上げの材料や調味料を添える。';
  }
  return '元レシピの順序に沿って材料を合わせ、料理を仕上げる。';
}

function compressSteps(stepTexts) {
  const result = [];
  for (const text of stepTexts) {
    const step = conciseStep(text);
    if (step && !result.includes(step)) result.push(step);
    if (result.length >= 7) break;
  }
  return result.length ? result : ['元レシピの手順に沿って材料を下ごしらえし、中心まで十分に加熱して仕上げる。'];
}

function parseIsoDuration(value) {
  const match = String(value || '').match(/^P(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?)?$/);
  if (!match) return null;
  return Number(match[1] || 0) * 1440 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function categoryFor(foods, name) {
  if (foods.some(food => food.includes('鶏'))) return '鶏肉料理';
  if (foods.some(food => food.includes('豚'))) return '豚肉料理';
  if (foods.some(food => food.includes('牛'))) return '牛肉料理';
  if (foods.some(food => food === '魚' || food === '魚介')) return '魚介料理';
  if (foods.includes('卵')) return '卵料理';
  if (foods.some(food => food.includes('豆'))) return '豆・大豆料理';
  if (/ご飯|丼|うどん|そば|パスタ|麺/.test(name)) return '主食';
  return 'たんぱく質を含む料理';
}

function tagsFor(name, ingredients, foods) {
  const text = `${name} ${ingredients.join(' ')}`;
  const tags = [...foods];
  for (const [pattern, tag] of [
    [/レンジ|電子レンジ/, 'レンジ調理'],
    [/フライパン/, 'フライパン'],
    [/煮|スープ|汁/, '煮物・汁物'],
    [/炒/, '炒め物'],
    [/焼|ソテー|グリル/, '焼き物'],
    [/サラダ|和え/, 'サラダ・和え物'],
    [/ご飯|丼|うどん|そば|パスタ|麺/, '主食'],
  ]) {
    if (pattern.test(text) && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, 6);
}

function ingredientEvidence(htmlText, ingredients) {
  const text = normalizedMatchText(htmlText);
  const probes = ingredients
    .map(item => clean(item.name).replace(/^[<(（【].*[>）】)]$/, ''))
    .filter(name => japanesePattern.test(name) && name.length >= 2)
    .slice(0, 8);
  return probes.some(name => text.includes(normalizedMatchText(name).slice(0, 8)));
}

async function loadSource(source) {
  const folder = `${RAW_BASE}/${source.key}`;
  console.log(`${source.label}の公開データを読み込んでいます。`);

  const [ingredientsResponse, stepsResponse, recipesResponse] = await Promise.all([
    fetchText(`${folder}/ingredients.csv`, { timeoutMs: 60000, attempts: 3 }),
    fetchText(`${folder}/make_list.csv`, { timeoutMs: 60000, attempts: 3 }),
    fetchText(`${folder}/recipes.csv`, { timeoutMs: 60000, attempts: 3 }).catch(() => ({ text: '' })),
  ]);

  const ingredientRows = ingredientsResponse.text.split(/\r?\n/).map(parseIngredientLine).filter(Boolean);
  const stepRows = stepsResponse.text.split(/\r?\n/).map(parseStepLine).filter(Boolean);
  const recipeRows = recipesResponse.text.split(/\r?\n/).map(parseRecipeLine).filter(Boolean);
  const ingredientsById = groupById(ingredientRows);
  const stepsById = groupById(stepRows);
  const metadataById = new Map(recipeRows.map(row => [row.id, row]));

  const ids = [...ingredientsById.keys()].filter(id => source.idPattern.test(id) && stepsById.has(id));
  const candidates = ids
    .map(id => {
      const ingredients = ingredientsById.get(id) || [];
      const steps = stepsById.get(id) || [];
      const metadata = metadataById.get(id) || {};
      const name = clean(metadata.name || '');
      const protein = proteinInfo(name, ingredients);
      return {
        source,
        id,
        name,
        url: metadata.url || source.urlFromId(id),
        ingredients,
        steps,
        protein,
        timeMinutes: Number.isFinite(metadata.timeMinutes) && metadata.timeMinutes > 0 ? metadata.timeMinutes : null,
        calories: Number.isFinite(metadata.calories) && metadata.calories > 0 ? metadata.calories : null,
        saltGrams: Number.isFinite(metadata.saltGrams) && metadata.saltGrams >= 0 ? metadata.saltGrams : null,
        servings: Number.isFinite(metadata.servings) && metadata.servings > 0 ? metadata.servings : null,
      };
    })
    .filter(item => item.ingredients.length >= 3 && item.steps.length >= 1)
    .filter(item => !item.name || !dessertPattern.test(item.name))
    .filter(item => item.protein.score >= 4)
    .sort((a, b) => b.protein.score - a.protein.score || a.id.localeCompare(b.id));

  console.log(`${source.label}: 材料${ingredientRows.length}行・手順${stepRows.length}行・候補${candidates.length}件`);
  return candidates;
}

function roundRobin(groups) {
  const result = [];
  let index = 0;
  while (groups.some(group => index < group.length)) {
    for (const group of groups) {
      if (index < group.length) result.push(group[index]);
    }
    index += 1;
  }
  return result;
}

async function verifyCandidate(candidate) {
  try {
    const { text: html, response } = await fetchText(candidate.url, { timeoutMs: 15000, attempts: 2 });
    const finalUrl = clean(response.url || candidate.url);
    const visibleText = stripHtml(html);
    const ld = extractRecipeJsonLd(html);
    const pageName = extractPageName(html, ld);
    const liveIngredients = Array.isArray(ld?.recipeIngredient)
      ? ld.recipeIngredient.map(clean).filter(Boolean)
      : [];
    const liveSteps = jsonLdSteps(ld);
    const name = pageName || candidate.name;
    const matched = titleMatches(candidate.name, name);

    const host = new URL(finalUrl).hostname.replace(/^www\./, '');
    const expectedHost = candidate.source.domain.replace(/^www\./, '');
    const hostMatches = host === expectedHost || host.endsWith(`.${expectedHost}`) || expectedHost.endsWith(`.${host}`);
    const pageLooksValid = response.ok
      && hostMatches
      && Boolean(name)
      && japanesePattern.test(name)
      && !dessertPattern.test(name)
      && !errorPagePattern.test(`${name} ${visibleText.slice(0, 800)}`)
      && (Boolean(ld) || ingredientEvidence(visibleText, candidate.ingredients) || matched === true);

    if (!pageLooksValid) throw new Error('公開中のレシピページとして確認できませんでした');

    return {
      ok: true,
      status: response.status,
      finalUrl,
      checkedAt: new Date().toISOString(),
      name,
      titleMatched: matched,
      liveIngredients,
      liveSteps,
      jsonLd: ld,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      finalUrl: candidate.url,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      await sleep(120);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

async function main() {
  console.log('日本のレシピサイト4社から候補データを準備します。');
  const sourceGroups = await Promise.all(SOURCES.map(loadSource));
  const candidates = roundRobin(sourceGroups).slice(0, MAX_PAGES);

  console.log(`確認対象候補: ${candidates.length}件。500件に達するまで各URLを1件ずつ確認します。`);
  if (candidates.length < TARGET) throw new Error(`確認候補が${candidates.length}件しかありません。`);

  const accepted = [];
  const verifications = [];
  const seenUrls = new Set();
  const seenNames = new Set();
  let completed = 0;

  for (let offset = 0; offset < candidates.length && accepted.length < TARGET; offset += BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + BATCH_SIZE);
    const batchResults = await mapWithConcurrency(batch, CONCURRENCY, async candidate => {
      const verification = await verifyCandidate(candidate);
      completed += 1;
      if (completed % 25 === 0 || completed === candidates.length) {
        console.log(`確認済み ${completed}/${candidates.length}・合格 ${accepted.length}/${TARGET}`);
      }
      return { candidate, verification };
    });

    verifications.push(...batchResults);

    for (const item of batchResults) {
      const { candidate, verification } = item;
      if (!verification.ok) continue;

      const normalizedUrl = verification.finalUrl.replace(/\/$/, '');
      const normalizedName = normalizedMatchText(verification.name);
      if (seenUrls.has(normalizedUrl) || seenNames.has(normalizedName)) continue;

      const ingredients = verification.liveIngredients.length >= 3
        ? verification.liveIngredients
        : candidate.ingredients.map(normalizeIngredient).filter(Boolean);
      const rawSteps = verification.liveSteps.length >= 1
        ? verification.liveSteps
        : candidate.steps.sort((a, b) => a.order - b.order).map(step => step.text);
      const steps = compressSteps(rawSteps);
      const effectiveProtein = proteinInfo(verification.name, ingredients.map(value => ({ name: value })));
      const protein = effectiveProtein.score >= 4 ? effectiveProtein : candidate.protein;

      if (ingredients.length < 3 || steps.length < 1 || protein.score < 4) continue;

      seenUrls.add(normalizedUrl);
      seenNames.add(normalizedName);
      accepted.push({ candidate, verification, ingredients, steps, protein });
      if (accepted.length >= TARGET) break;
    }

    console.log(`バッチ完了・確認${completed}件・合格${accepted.length}/${TARGET}`);
    if (accepted.length < TARGET) await sleep(500);
  }

  if (accepted.length < TARGET) {
    const partialReport = {
      generatedAt: new Date().toISOString(),
      targetCount: TARGET,
      outputCount: accepted.length,
      pagesChecked: verifications.length,
      sourceCounts: Object.fromEntries(SOURCES.map(source => [source.label, accepted.filter(item => item.candidate.source.key === source.key).length])),
      failures: verifications.filter(item => !item.verification.ok).slice(0, 1000).map(item => ({
        source: item.candidate.source.label,
        id: item.candidate.id,
        url: item.candidate.url,
        error: item.verification.error,
      })),
    };
    await fs.writeFile('recipes-validation-partial.json', `${JSON.stringify(partialReport, null, 2)}\n`, 'utf8');
    throw new Error(`現在の公開ページで確認できたのは${accepted.length}件でした。確認結果はrecipes-validation-partial.jsonへ保存しました。`);
  }

  const recipes = accepted.slice(0, TARGET).map(({ candidate, verification, ingredients, steps, protein }, index) => {
    const ldTime = parseIsoDuration(
      verification.jsonLd?.totalTime
      || verification.jsonLd?.cookTime
      || verification.jsonLd?.prepTime
    );
    const goals = ['maintain'];
    if (protein.score >= 6) goals.push('muscle');
    if (protein.lean && (candidate.calories === null || candidate.calories <= 550)) goals.push('cut');

    return {
      id: `jp-${candidate.source.key}-${String(index + 1).padStart(4, '0')}`,
      sourceRecipeId: candidate.id,
      name: verification.name,
      category: categoryFor(protein.foods, verification.name),
      area: '日本の家庭料理',
      tags: tagsFor(verification.name, ingredients, protein.foods),
      ingredients,
      steps,
      timeMinutes: ldTime || candidate.timeMinutes,
      calories: candidate.calories,
      saltGrams: candidate.saltGrams,
      servings: candidate.servings,
      proteinScore: protein.score,
      proteinLabel: protein.score >= 12 ? 'かなり高め' : protein.score >= 7 ? '高め' : '中程度',
      proteinFoods: protein.foods,
      goals: [...new Set(goals)],
      sourceName: candidate.source.label,
      sourceDomain: candidate.source.domain,
      sourceUrl: verification.finalUrl,
      checkedAt: verification.checkedAt,
      pageStatus: verification.status,
      pageTitleMatched: verification.titleMatched,
      dataOrigin: verification.liveIngredients.length >= 3 && verification.liveSteps.length >= 1
        ? '現在の公開ページ'
        : '現在の公開ページ確認済み・保存済み公開データを要約',
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    targetCount: TARGET,
    outputCount: recipes.length,
    sources: SOURCES.map(source => source.label),
    sourceDatasetCommit: SOURCE_COMMIT,
    pagesChecked: verifications.length,
    pagesReachable: verifications.filter(item => item.verification.ok).length,
    pagesFailed: verifications.filter(item => !item.verification.ok).length,
    sourceCounts: Object.fromEntries(SOURCES.map(source => [source.label, recipes.filter(recipe => recipe.sourceName === source.label).length])),
    livePageDataCount: recipes.filter(recipe => recipe.dataOrigin === '現在の公開ページ').length,
    archivedDataFallbackCount: recipes.filter(recipe => recipe.dataOrigin !== '現在の公開ページ').length,
    displayLanguage: 'ja',
    records: recipes.map((recipe, index) => ({
      index: index + 1,
      id: recipe.id,
      name: recipe.name,
      sourceName: recipe.sourceName,
      sourceUrl: recipe.sourceUrl,
      status: recipe.pageStatus,
      checkedAt: recipe.checkedAt,
      dataOrigin: recipe.dataOrigin,
    })),
    failures: verifications.filter(item => !item.verification.ok).slice(0, 1500).map(item => ({
      source: item.candidate.source.label,
      id: item.candidate.id,
      url: item.candidate.url,
      error: item.verification.error,
    })),
  };

  if (recipes.length !== TARGET) throw new Error(`出力件数が${recipes.length}件です。`);
  if (new Set(recipes.map(recipe => recipe.sourceUrl.replace(/\/$/, ''))).size !== TARGET) throw new Error('出典URLが重複しています。');
  if (new Set(recipes.map(recipe => normalizedMatchText(recipe.name))).size !== TARGET) throw new Error('料理名が重複しています。');
  if (recipes.some(recipe => !recipe.name || recipe.ingredients.length < 3 || recipe.steps.length < 1 || !recipe.sourceUrl)) {
    throw new Error('必須データが欠けているレシピがあります。');
  }

  await fs.writeFile('recipes.json', `${JSON.stringify(recipes, null, 2)}\n`, 'utf8');
  await fs.writeFile('recipes-validation.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`完了: 確認済み日本語レシピ${recipes.length}件をrecipes.jsonへ保存しました。`);
  console.log(`内訳: ${Object.entries(report.sourceCounts).map(([name, count]) => `${name} ${count}件`).join(' / ')}`);
}

export { parseIngredientLine, parseStepLine, extractRecipeJsonLd, extractPageName, conciseStep, compressSteps, proteinInfo, normalizedMatchText };

if (process.env.KINNMESHI_SKIP_MAIN !== '1') {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
