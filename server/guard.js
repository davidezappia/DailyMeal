// Keeps AI-generated meals inside the plan: only plan options, short details made of known words, no excluded foods.
import { planChoices, DETAIL_SEP, mentionsExcluded, norm } from './day.js';

// Crude Italian stem so singular/plural match (zucchina/zucchine → zucchin).
const stem = (w) => w.replace(/[aeiou]$/, '');
export const wordsOf = (s) => norm(s).split(/[^a-z]+/).filter((w) => w.length >= 4).map(stem);

// Specifications the plan's generic items allow ("verdure", "frutta di stagione", "cereali"…) and plain cooking words.
const COMMON = `
zucchina zucchine melanzana melanzane peperone peperoni pomodoro pomodori pomodorini carota carote sedano finocchio finocchi
spinaci bietola bietole cavolfiore cavolo cavoli broccolo broccoli broccoletti verza cappuccio cavolini bruxelles rapa rape cime
radicchio lattuga insalata rucola valeriana songino indivia scarola cicoria catalogna puntarelle carciofo carciofi asparagi
fagiolini cetriolo cetrioli zucca porro porri cipolla cipolle scalogno funghi champignon porcini barbabietola rapanelli ravanelli
germogli misticanza cavolo nero friarielli agretti erbette
mela mele pera pere arancia arance mandarino mandarini clementine kiwi melagrana pompelmo limone ananas fragola fragole
albicocca albicocche pesca pesche nettarina susina susine prugna prugne ciliegie anguria melone mirtilli lamponi more
mango papaya avocado
petto filetto fesa coscia fusi bistecca tagliata straccetti hamburger polpette tranci trancio verde neutro neutra integrali
riso basmati integrale venere rosso parboiled farro orzo perlato miglio quinoa couscous bulgur grano saraceno kamut avena
segale amaranto teff pasta spaghetti penne fusilli rigatoni farfalle linguine tagliatelle trofie orecchiette gnocchi pane
tostato fette patata patate novelle dolci
pollo tacchino coniglio vitello manzo bovino lonza maiale cavallo merluzzo nasello platessa sogliola spigola branzino orata
dentice salmone tonno sgombro trota gamberi gamberetti calamari seppie polpo cozze vongole alici acciughe sardine
ceci lenticchie fagioli borlotti cannellini piselli fave edamame
basilico prezzemolo rosmarino salvia origano timo menta erba cipollina aneto curcuma zenzero pepe peperoncino curry paprika
noce moscata limone aceto zafferano erbe aromatiche spezie
forno griglia grigliato grigliati grigliata piastra vapore padella cartoccio lesso lessato lessati bollito crudo cruda crude
cotto cotta saltato saltati spadellato stufato stufati gratinato gratinati arrosto arrostito julienne bastoncini cubetti
insalata vellutata purea passata contorno misto mista misti miste fresco fresca freschi fresche leggero leggera stagione
piatto ciotola bowl tiepido tiepida freddo fredda caldo calda semplice semplici scottato scottata marinato marinata
`;
const COMMON_WORDS = new Set(wordsOf(COMMON));

/** Words allowed in details and titles: everything the plan says, plus common produce and cooking words. */
export function vocabulary(plan) {
  const text = JSON.stringify(plan);
  return new Set([...wordsOf(text), ...COMMON_WORDS]);
}


const known = (text, vocab) => wordsOf(text).every((w) => vocab.has(w));
const shortName = (item) => {
  const [option, detail] = item.split(DETAIL_SEP);
  const base = (detail || option.replace(/^[\d.,\s]*(g|ml|c\.|cucchiai\w*)?\s*/i, '')).split(/[(/–-]/)[0].trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
};

/**
 * Rebuilds one generated meal from plan options only.
 * @param {object} plan @param {number} wd plan weekday @param {{slot:string,title:string,free?:boolean,items:{option:string,detail:string}[]}} meal
 * @param {Set<string>} vocab @param {string[]} excluded
 */
export function sanitizeMeal(plan, wd, meal, vocab, excluded = []) {
  // Only the plan decides which meal is free, not the model.
  const planFree = plan.days.find((d) => d.weekday === wd)?.meals.find((m) => m.slot === meal.slot)?.free;
  if (planFree) return { slot: meal.slot, title: 'Pasto libero', items: [], free: true };
  const groups = planChoices(plan, wd, meal.slot);
  if (!groups.length) return null; // slot not in the plan for that day
  const picked = Array.isArray(meal.items) ? meal.items.filter((i) => i && typeof i.option === 'string') : [];
  const hits = (g) => picked.filter((i) => g.items.some((it) => it.options.includes(i.option))).length;
  const group = groups.reduce((best, g) => (hits(g) > hits(best) ? g : best), groups[0]);

  const items = group.items.map((it) => {
    const allowed = it.options.filter((o) => !mentionsExcluded(o, excluded));
    const choice = picked.find((i) => allowed.includes(i.option));
    if (!choice && it.optional) return null;
    const option = choice?.option ?? allowed[0] ?? it.options[0];
    const detail = (choice?.detail || '').trim();
    const detailOk = detail && detail.length <= 60 && known(detail, vocab) && !mentionsExcluded(detail, excluded);
    return detailOk ? option + DETAIL_SEP + detail : option;
  }).filter(Boolean);

  const title = (meal.title || '').trim();
  const titleOk = title && title.length <= 80 && known(title, vocab) && !mentionsExcluded(title, excluded);
  return { slot: meal.slot, title: titleOk ? title : items.slice(0, 2).map(shortName).join(' e '), items, free: false };
}
