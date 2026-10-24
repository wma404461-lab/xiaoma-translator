// A complete lexical rank with one explicit English grade; ambiguity is kept.
const grades=[
  [/\b(?:lieutenant|lt\.?)\s+(?:colonel|col\.?)\b/gi,'中校'],
  [/\b(?:brigadier|brig\.?)\s+general\b/gi,'准将'],
  [/\b(?:major|maj\.?)\s+general\b/gi,'少将'],
  [/\b(?:lieutenant|lt\.?)\s+general\b/gi,'中将'],
  [/\bcolonels?\b/gi,'上校'],
];
const ranks=/上校|中校|少校|上将|中将|少将|准将|将军/g;
const otherRole=/\b(?:generals?|colonels?|admirals?|captains?|majors?|lieutenants?|sergeants?|commanders?)\b/i;
const chess=/\b(?:chess|checkmat(?:e|ed|ing)|in\s+check)\b/i;
const tokenizer=typeof Intl.Segmenter==='function'?new Intl.Segmenter('zh-CN',{granularity:'word'}):null;
export function normalizeExplicitRank(source,translated){
  if(typeof source!=='string'||typeof translated!=='string'||!tokenizer)return translated;
  let remainder=source,found=[];
  for(const [pattern,rank] of grades)remainder=remainder.replace(pattern,()=>{found.push(rank);return ' ';});
  if(found.length!==1||otherRole.test(remainder))return translated;
  const mentions=[...translated.matchAll(ranks)];
  if(mentions.length!==1||mentions[0][0]===found[0])return translated;
  const mention=mentions[0],end=mention.index+mention[0].length;
  if(![...tokenizer.segment(translated)].some(token=>token.isWordLike&&token.index===mention.index&&token.segment===mention[0]))return translated;
  const following=translated.slice(end),preceding=translated.slice(0,mention.index);
  if(/^(?:街|路|镇|村|山|岛|府|大道|公园|剧院|博物馆)/.test(following))return translated;
  if(mention[0]==='将军'&&(chess.test(source)||/^(?:肚|令|了|一下|一回|一招|[!！呀啊吧呢])/.test(following)||/(?:被|再|先|要|来|把|给|让)$/.test(preceding)))return translated;
  return preceding+found[0]+following;
}
