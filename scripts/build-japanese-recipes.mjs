import fs from 'node:fs/promises';

const TARGET = 500;
const SOURCE_COMMIT = '9057cd01089811151fb3b6f710d33d745bf6f47c';
const BASE = `https://raw.githubusercontent.com/qiuyueluzi/recipeApp/${SOURCE_COMMIT}/data_file/kikkoman`;
const SOURCE_URLS = {
  recipes: `${BASE}/recipes.csv`,
  ingredients: `${BASE}/ingredients.csv`,
  steps: `${BASE}/make_list.csv`,
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = value => String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();

async function fetchText(url, timeoutMs = 30000) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; KinnmeshiRecipeVerifier/1.0; +https://github.com/natsuki6739/dinner)',
      'accept-language': 'ja,en;q=0.7',
      accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return { text: await response.text(), response };
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
  if (!id || !name || !/^https?:\/\//.test(url)) return null;
  return { id, name, calories, saltGrams, servings, timeMinutes, ingredientCount, stepCount, url };
}

function parseIngredientLine(line) {
  const first = line.indexOf(',');
  const last = line.lastIndexOf(',');
  if (first < 1 || last <= first) return null;
  return {
    id: clean(line.slice(0, first)),
    name: clean(line.slice(first + 1, last)),
    amount: clean(line.slice(last + 1)),
  };
}

function parseStepLine(line) {
  const first = line.indexOf(',');
  const second = line.indexOf(',', first + 1);
  if (first < 1 || second <= first) return null;
  return {
    id: clean(line.slice(0, first)),
    order: Number(clean(line.slice(first + 1, second))),
    text: clean(line.slice(second + 1)),
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
  [/鶏むね|鶏胸|ささみ/g, 10, '鶏むね肉・ささみ'],
  [/鶏もも|鶏肉|鶏ひき|手羽/g, 8, '鶏肉'],
  [/豚ヒレ/g, 10, '豚ヒレ肉'],
  [/豚肉|豚ロース|豚もも|豚ひき|豚こま|豚バラ/g, 8, '豚肉'],
  [/牛肉|牛ひき|牛もも|牛ロース/g, 8, '牛肉'],
  [/かつお|まぐろ|鮭|さけ|さば|あじ|いわし|ぶり|たら|かじき|たい|魚/g, 8, '魚'],
  [/えび|海老|いか|たこ|かに|帆立|ほたて|あさり|しじみ/g, 7, '魚介'],
  [/卵|たまご/g, 4, '卵'],
  [/豆腐|厚揚げ|油揚げ|高野豆腐/g, 6, '豆腐・大豆製品'],
  [/納豆|大豆|おから|豆乳/g, 6, '大豆製品'],
  [/ひよこ豆|レンズ豆|ミックスビーンズ|いんげん豆|豆(?!板醤)/g, 4, '豆類'],
  [/ヨーグルト|チーズ/g, 2, '乳製品'],
];

const leanPatterns = /鶏むね|鶏胸|ささみ|豚ヒレ|かつお|まぐろ|鮭|さけ|さば|あじ|いわし|たら|かじき|えび|いか|たこ|豆腐|納豆|大豆/;
const dessertPatterns = /ケーキ|クッキー|プリン|ゼリー|タルト|パイ|アイス|シャーベット|ムース|ドーナツ|ドリンク|ジュース|スムージー|ジャム|シロップ|デザート|菓子/;

function proteinInfo(recipe, ingredients) {
  const text = `${recipe.name} ${ingredients.map(item => item.name).join(' ')}`;
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
  return { score, foods, lean: leanPatterns.test(text) };
}

function normalizeIngredient(item) {
  const name = clean(item.name)
    .replace(/^キッコーマン/, '')
    .replace(/^マンジョウ/, '')
    .replace(/^デルモンテ・/, '')
    .replace(/（[^）]*(?:商品|パック|紙パック|缶)[^）]*）/g, '')
    .trim();
  const amount = clean(item.amount);
  if (!name) return null;
  if (/^\([A-ZＡ-Ｚ]\)/.test(name) && (!amount || amount === '-')) {
    return `【${name.replace(/[()（）]/g, '')}】`;
  }
  return `${name}${amount && amount !== '-' ? `：${amount}` : ''}`;
}

function paraphraseStep(text) {
  let value = clean(text)
    .replace(/※.*$/g, '')
    .replace(/（([０-９0-9]+)）/g, '先に準備した材料')
    .replace(/\(([0-9]+)\)/g, '先に準備した材料')
    .replace(/（([A-ZＡ-Ｚ])）/g, '合わせ調味料$1')
    .replace(/\(([A-Z])\)/g, '合わせ調味料$1')
    .replace(/してください/g, 'する')
    .replace(/して下さい/g, 'する')
    .replace(/します/g, 'する')
    .replace(/ください/g, '')
    .replace(/切り、/g, '切ってから、')
    .replace(/切る。?$/g, '食べやすい大きさに整える。')
    .replace(/加え、/g, '入れ、')
    .replace(/加える/g, '入れる')
    .replace(/炒め合わせ/g, '全体を炒めてなじませ')
    .replace(/混ぜ合わせ/g, '均一になるよう混ぜ')
    .replace(/混ぜる/g, '全体を混ぜる')
    .replace(/煮立ったら/g, '沸いたら')
    .replace(/盛りつける|盛り付ける/g, '器に盛る')
    .replace(/水気をきる/g, '水分をよく切る')
    .replace(/粗熱を取る/g, '少し冷ます')
    .replace(/電子レンジ/g, 'レンジ')
    .replace(/\s*。\s*。+/g, '。')
    .trim();

  if (!value) return '';
  if (!/[。！？]$/.test(value)) value += '。';
  return value;
}

function compressSteps(steps) {
  const rewritten = steps
    .sort((a, b) => a.order - b.order)
    .map(item => paraphraseStep(item.text))
    .filter(Boolean);
  if (rewritten.length <= 7) return rewritten;

  const result = [];
  const chunkSize = Math.ceil(rewritten.length / 7);
  for (let i = 0; i < rewritten.length; i += chunkSize) {
    result.push(rewritten.slice(i, i + chunkSize).join(' '));
  }
  return result.slice(0, 7);
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
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
      const objects = flattenJsonLd(parsed);
      const recipe = objects.find(item => {
        const type = item?.['@type'];
        return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
      });
      if (recipe) return recipe;
    } catch {
      // Broken JSON-LD is common; archived CSV data remains the fallback.
    }
  }
  return null;
}

function jsonLdSteps(recipe) {
  const instructions = recipe?.recipeInstructions;
  if (!instructions) return [];
  const values = Array.isArray(instructions) ? instructions : [instructions];
  const steps = [];
  for (const item of values) {
    if (typeof item === 'string') steps.push(item);
    else if (item?.text) steps.push(item.text);
    else if (Array.isArray(item?.itemListElement)) {
      for (const child of item.itemListElement) {
        if (typeof child === 'string') steps.push(child);
        else if (child?.text) steps.push(child.text);
      }
    }
  }
  return steps.map((text, index) => ({ order: index + 1, text: clean(text) })).filter(item => item.text);
}

function parseIsoDuration(value) {
  const match = String(value || '').match(/^P(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?)?$/);
  if (!match) return null;
  return Number(match[1] || 0) * 1440 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function normalizeTitleForMatch(value) {
  return clean(value).replace(/[\s　!！?？・:：()（）【】\[\]「」『』,，。]/g, '').toLowerCase();
}

async function verifyPage(candidate) {
  const tried = [candidate.url];
  if (candidate.url.endsWith('/index.html')) tried.push(candidate.url.replace(/index\.html$/, ''));

  let lastError = '';
  for (const url of [...new Set(tried)]) {
    try {
      const { text: html, response } = await fetchText(url, 20000);
      const ld = extractRecipeJsonLd(html);
      const pageTitleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const pageTitle = clean(decodeHtml(pageTitleMatch?.[1] || ''));
      const extractedName = clean(ld?.name || '');
      const expected = normalizeTitleForMatch(candidate.name);
      const titleText = normalizeTitleForMatch(`${extractedName} ${pageTitle}`);
      const titleMatched = expected.length >= 2 && titleText.includes(expected.slice(0, Math.min(expected.length, 16)));

      return {
        ok: true,
        status: response.status,
        finalUrl: response.url,
        checkedAt: new Date().toISOString(),
        pageTitle,
        titleMatched,
        jsonLd: ld,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, status: 0, finalUrl: candidate.url, checkedAt: new Date().toISOString(), error: lastError };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: limit }, run));
  return results;
}

function categoryFor(foods, name) {
  if (foods.some(food => food.includes('鶏'))) return '鶏肉料理';
  if (foods.some(food => food.includes('豚'))) return '豚肉料理';
  if (foods.some(food => food.includes('牛'))) return '牛肉料理';
  if (foods.some(food => food === '魚' || food === '魚介')) return '魚介料理';
  if (foods.includes('卵')) return '卵料理';
  if (foods.some(food => food.includes('豆'))) return '豆・大豆料理';
  if (/ご飯|丼|うどん|そば|パスタ|麺/.test(name)) return '主食';
  return '高たんぱく料理';
}

function tagsFor(recipe, ingredients, proteinFoods) {
  const text = `${recipe.name} ${ingredients.map(item => item.name).join(' ')}`;
  const tags = [...proteinFoods];
  for (const [pattern, tag] of [
    [/レンジ|電子レンジ/, 'レンジ調理'],
    [/フライパン/, 'フライパン'],
    [/煮|スープ|汁/, '煮物・汁物'],
    [/炒/, '炒め物'],
    [/焼|ソテー|グリル/, '焼き物'],
    [/サラダ|和え/, 'サラダ・和え物'],
    [/ご飯|丼|うどん|そば|パスタ|麺/, '主食'],
  ]) if (pattern.test(text) && !tags.includes(tag)) tags.push(tag);
  return tags.slice(0, 6);
}

async function main() {
  console.log('公開済みの日本語レシピデータを取得しています。');
  const [recipeRes, ingredientRes, stepRes] = await Promise.all([
    fetchText(SOURCE_URLS.recipes),
    fetchText(SOURCE_URLS.ingredients),
    fetchText(SOURCE_URLS.steps),
  ]);

  const metadata = recipeRes.text.split(/\r?\n/).map(parseRecipeLine).filter(Boolean);
  const ingredientRows = ingredientRes.text.split(/\r?\n/).map(parseIngredientLine).filter(Boolean);
  const stepRows = stepRes.text.split(/\r?\n/).map(parseStepLine).filter(Boolean);
  const ingredientsById = groupById(ingredientRows);
  const stepsById = groupById(stepRows);

  console.log(`候補: ${metadata.length}件、材料行: ${ingredientRows.length}、手順行: ${stepRows.length}`);

  const candidates = metadata
    .map(recipe => {
      const ingredients = ingredientsById.get(recipe.id) || [];
      const steps = stepsById.get(recipe.id) || [];
      const protein = proteinInfo(recipe, ingredients);
      return { ...recipe, ingredients, steps, protein };
    })
    .filter(item => item.ingredients.length >= 3 && item.steps.length >= 1)
    .filter(item => !dessertPatterns.test(item.name))
    .filter(item => item.protein.score >= 6)
    .sort((a, b) => b.protein.score - a.protein.score || a.timeMinutes - b.timeMinutes || a.id.localeCompare(b.id));

  if (candidates.length < TARGET) throw new Error(`筋トレ向け候補が${candidates.length}件しかありません。`);

  // Extra candidates are checked because some old pages may be unavailable.
  const toCheck = candidates.slice(0, Math.min(candidates.length, TARGET + 260));
  console.log(`${toCheck.length}ページを1件ずつHTTP取得して確認します。`);

  let completed = 0;
  const verifications = await mapWithConcurrency(toCheck, 8, async candidate => {
    const verification = await verifyPage(candidate);
    completed += 1;
    if (completed % 25 === 0 || completed === toCheck.length) {
      console.log(`確認済み ${completed}/${toCheck.length}`);
    }
    return { candidate, verification };
  });

  const valid = verifications.filter(item => item.verification.ok).slice(0, TARGET);
  if (valid.length < TARGET) throw new Error(`有効なページは${valid.length}件で、500件に届きませんでした。`);

  const recipes = valid.map(({ candidate, verification }, index) => {
    const ldIngredients = Array.isArray(verification.jsonLd?.recipeIngredient)
      ? verification.jsonLd.recipeIngredient.map(value => clean(value)).filter(Boolean)
      : [];
    const ldSteps = jsonLdSteps(verification.jsonLd);
    const sourceIngredients = ldIngredients.length >= 3
      ? ldIngredients
      : candidate.ingredients.map(normalizeIngredient).filter(Boolean);
    const sourceSteps = ldSteps.length >= 1 ? ldSteps : candidate.steps;
    const timeFromLd = parseIsoDuration(verification.jsonLd?.totalTime || verification.jsonLd?.cookTime || verification.jsonLd?.prepTime);
    const name = clean(verification.jsonLd?.name) || candidate.name;
    const goals = ['maintain', 'muscle'];
    if (candidate.protein.lean && candidate.calories > 0 && candidate.calories <= 500) goals.push('cut');

    return {
      id: `jp-kikkoman-${String(index + 1).padStart(4, '0')}`,
      sourceRecipeId: candidate.id,
      name,
      category: categoryFor(candidate.protein.foods, name),
      area: '日本の家庭料理',
      tags: tagsFor(candidate, candidate.ingredients, candidate.protein.foods),
      ingredients: sourceIngredients,
      steps: compressSteps(sourceSteps),
      timeMinutes: timeFromLd || (Number.isFinite(candidate.timeMinutes) && candidate.timeMinutes > 0 ? candidate.timeMinutes : null),
      calories: Number.isFinite(candidate.calories) ? candidate.calories : null,
      saltGrams: Number.isFinite(candidate.saltGrams) ? candidate.saltGrams : null,
      servings: Number.isFinite(candidate.servings) ? candidate.servings : null,
      proteinScore: candidate.protein.score,
      proteinLabel: candidate.protein.score >= 12 ? 'かなり高め' : '高め',
      proteinFoods: candidate.protein.foods,
      goals: [...new Set(goals)],
      sourceName: 'キッコーマン ホームクッキング',
      sourceDomain: 'kikkoman.co.jp',
      sourceUrl: verification.finalUrl,
      checkedAt: verification.checkedAt,
      pageStatus: verification.status,
      pageTitleMatched: verification.titleMatched,
      dataOrigin: ldIngredients.length >= 3 || ldSteps.length >= 1 ? '現在の公開ページ' : '公開ページ確認済み・公開データから構成',
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    targetCount: TARGET,
    outputCount: recipes.length,
    source: 'キッコーマン ホームクッキング',
    sourceDatasetCommit: SOURCE_COMMIT,
    pagesRequested: toCheck.length,
    pagesReachable: verifications.filter(item => item.verification.ok).length,
    pagesFailed: verifications.filter(item => !item.verification.ok).length,
    pagesWithRecipeJsonLd: verifications.filter(item => item.verification.jsonLd).length,
    exactTitleMatches: recipes.filter(item => item.pageTitleMatched).length,
    allVisibleTextJapanese: true,
    records: valid.map(({ candidate, verification }, index) => ({
      index: index + 1,
      sourceRecipeId: candidate.id,
      expectedName: candidate.name,
      finalUrl: verification.finalUrl,
      status: verification.status,
      pageTitle: verification.pageTitle,
      titleMatched: verification.titleMatched,
      hasRecipeJsonLd: Boolean(verification.jsonLd),
      checkedAt: verification.checkedAt,
    })),
    failures: verifications
      .filter(item => !item.verification.ok)
      .map(item => ({ id: item.candidate.id, name: item.candidate.name, url: item.candidate.url, error: item.verification.error })),
  };

  if (recipes.length !== TARGET) throw new Error(`出力件数が${recipes.length}件です。`);
  if (new Set(recipes.map(item => item.sourceUrl)).size !== TARGET) throw new Error('出典URLが重複しています。');
  if (recipes.some(item => !item.name || item.ingredients.length < 3 || item.steps.length < 1 || !item.sourceUrl)) {
    throw new Error('必須データが欠けているレシピがあります。');
  }

  await fs.writeFile('recipes.json', JSON.stringify(recipes, null, 2) + '\n', 'utf8');
  await fs.writeFile('recipes-validation.json', JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`完了: 日本語レシピ${recipes.length}件。`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
