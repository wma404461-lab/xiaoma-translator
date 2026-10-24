// A complete lexical rank with one explicit English grade; ambiguity is kept.
const grades=[
  [/\b(?:lieutenant|lt\.?)\s+(?:colonel|col\.?)\b/gi,'\u4e2d\u6821'],
  [/\b(?:brigadier|brig\.?)\s+general\b/gi,'\u51c6\u5c06'],
  [/\b(?:major|maj\.?)\s+general\b/gi,'\u5c11\u5c06'],
  [/\b(?:lieutenant|lt\.?)\s+general\b/gi,'\u4e2d\u5c06'],
  [/\bcolonels?\b/gi,'\u4e0a\u6821'],
];
const ranks=/\u4e0a\u6821|\u4e2d\u6821|\u5c11\u6821|\u4e0a\u5c06|\u4e2d\u5c06|\u5c11\u5c06|\u51c6\u5c06|\u5c06\u519b/g;
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
  if(/^(?:\u8857|\u8def|\u9547|\u6751|\u5c71|\u5c9b|\u5e9c|\u5927\u9053|\u516c\u56ed|\u5267\u9662|\u535a\u7269\u9986)/.test(following))return translated;
  if(mention[0]==='\u5c06\u519b'&&(chess.test(source)||/^(?:\u809a|\u4ee4|\u4e86|\u4e00\u4e0b|\u4e00\u56de|\u4e00\u62db|[!！\u5440\u554a\u5427\u5462])/.test(following)||/(?:\u88ab|\u518d|\u5148|\u8981|\u6765|\u628a|\u7ed9|\u8ba9)$/.test(preceding)))return translated;
  return preceding+found[0]+following;
}
