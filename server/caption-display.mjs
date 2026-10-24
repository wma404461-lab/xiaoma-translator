// The desktop shows settled translation pages; draft meanings stay internal.
function splitText(text, limit) {
  const pieces=Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(String(text||'')),item=>item.segment),parts=[];
  while(pieces.length>limit){
    let end=limit;
    for(let index=limit-1;index>=Math.floor(limit*.55);index--){
      if(/[\s, ,; ;.!?!?, ]/u.test(pieces[index])){end=index+1;break;}
    }
    parts.push(pieces.splice(0,end).join('').trim());
  }
  if(pieces.length)parts.push(pieces.join('').trim());
  return parts.filter(Boolean);
}

export function captionPages(value,{zhLimit=28,enLimit=84}={}) {
  const sentences=(text,locale)=>Array.from(new Intl.Segmenter(locale,{granularity:'sentence'}).segment(String(text||'')),item=>item.segment.trim()).filter(Boolean);
  const zh=sentences(value.zh,'zh'),en=sentences(value.en,'en');
  const pairs=zh.length===en.length?zh.map((text,index)=>[text,en[index]]):[[value.zh,value.en]];
  const result=[];
  for(const [chinese,english] of pairs){
    const cn=splitText(chinese,zhLimit),original=splitText(english,enLimit);
    for(let index=0;index<Math.max(cn.length,original.length);index++)result.push({...value,zh:cn[Math.min(index,cn.length-1)]||'',en:original[Math.min(index,original.length-1)]||''});
  }
  return result.map((page,index)=>({...page,page:index+1,pageCount:result.length}));
}

export class CaptionDisplay {
  constructor({display,minHoldMs=3000,maxHoldMs=5000,maxQueuePages=6,pageOptions={},coalesce=false,now=()=>Date.now(),schedule=setTimeout,cancel=clearTimeout}) {
    Object.assign(this,{display,minHoldMs,maxHoldMs,maxQueuePages,pageOptions,coalesce,now,schedule,cancel});this.reset();
  }
  reset(){this.cancel(this.timer);this.timer=null;this.queue=[];this.current=null;this.lastAt=-Infinity;this.holdMs=0;this.latestSequence=-1;}
  offer(value) {
    if(!value.zh || value.final!==true || value.sequence<this.latestSequence)return;
    // Never rewrite a page already being read, including later revisions of it.
    if(this.current?.id===value.id)return;
    const previous=this.queue.find(page=>page.id===value.id);
    if(previous && (value.revision??0)<(previous.revision??0))return;
    this.latestSequence=value.sequence;
    this.queue=this.queue.filter(page=>page.id!==value.id);
    const pages=captionPages(value,this.pageOptions),last=this.queue.at(-1);
    // Merge only unread, confirmed short phrases. The visible text stays fixed.
    if(this.coalesce && value.sourceId && last?.sourceId && pages.length===1 && last.pageCount===1 && !last.en && !value.en && last.state===value.state && Array.from(last.zh+value.zh).length<=(this.pageOptions.zhLimit??28))this.queue[this.queue.length-1]={...pages[0],zh:last.zh+value.zh,translationReadyAt:last.translationReadyAt??pages[0].translationReadyAt};
    else this.queue.push(...pages);
    // Keep the display close to live when model recovery delivers a backlog.
    if(this.queue.length>this.maxQueuePages)this.queue.splice(0,this.queue.length-this.maxQueuePages);
    this.arm();
  }
  arm(){
    if(!this.queue.length || this.timer)return;
    const remaining=Math.max(0,this.holdMs-(this.now()-this.lastAt));
    if(!remaining){this.flush();return;}
    this.timer=this.schedule(()=>this.flush(),remaining);
  }
  flush(){
    this.cancel(this.timer);this.timer=null;
    const value=this.queue.shift();if(!value)return;
    this.current=value;this.lastAt=this.now();
    const readingMs=850+Math.max(Array.from(value.zh).length*120,Array.from(value.en).length*42);
    this.holdMs=Math.max(this.minHoldMs,Math.min(this.maxHoldMs,readingMs));
    this.display(value);this.arm();
  }
  close(){this.reset();}
}
