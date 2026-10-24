// English follows recognition immediately; it never waits for translation pages.
const acronyms=new Set('NASA NATO UNESCO FBI CIA BBC CNN CPU GPU API USB HDMI RAM SQL HTML CSS URL HTTP HTTPS TCP UDP DNS JSON XML GPT USA UK EU'.split(' '));
const names=new Map(['English','Chinese','Japanese','French','German','Spanish','China','America','London','Paris','Tokyo','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday','January','February','April','June','July','August','September','October','November','December','YouTube','Google','Microsoft','OpenAI','ChatGPT','Windows','Android','JavaScript','Python'].map(word=>[word.toLowerCase(),word]));
export function formatEnglish(text,{final=false}={}){
  let value=String(text||'').trim().replace(/\s+/g,' ');
  const letters=value.replace(/[^A-Za-z]/g,'');
  // Streaming Zipformer emits uppercase tokens. Whisper's already cased final
  // text remains authoritative, including names the display cannot infer.
  if(letters.length>1 && letters===letters.toUpperCase()){
    value=value.toLowerCase().replace(/\b[a-z]+\b/g,word=>acronyms.has(word.toUpperCase())?word.toUpperCase():names.get(word)||word);
    value=value.replace(/\b(?:[a-z]\.){2,}/g,word=>word.toUpperCase());
    value=value.replace(/\bnew york\b/gi,'New York').replace(/\bunited states\b/gi,'United States').replace(/\bunited kingdom\b/gi,'United Kingdom');
    value=value.replace(/(^|[!?]\s+|\.\s+)(["'“([{]*)([a-z])/g,(_,prefix,quote,letter)=>prefix+quote+letter.toUpperCase());
  }
  value=value.replace(/\bi\b/g,'I').replace(/\bI'(m|ve|ll|d|re)\b/gi,(_,tail)=>"I'"+tail.toLowerCase());
  if(final && value && !/[.!?…]["'”’)]*$/.test(value))value=value.replace(/[,;:]+(["'”’)]*)$/,'$1')+'.';
  return value;
}
export class LiveEnglish {
  constructor({display,maxChars=160}) {this.display=display;this.maxChars=maxChars;this.reset();}
  reset(){this.sequence=-1;this.id=null;this.revision=-1;this.final=false;this.text='';this.pageStart=0;}
  offer({id,text,sequence,revision=0,final=false,startedClientAt=null}) {
    if(!id || !Number.isSafeInteger(sequence) || sequence<this.sequence || !text?.trim())return;
    if(sequence===this.sequence && (id!==this.id || revision<this.revision || this.final))return;
    if(sequence>this.sequence){this.id=id;this.sequence=sequence;this.revision=-1;this.final=false;this.pageStart=0;}
    const formatted=formatEnglish(text,{final});
    const words=formatted.split(/\s+/);
    // A final recognizer correction can shorten the segment. Keep its last page visible.
    if(words.length<=this.pageStart || formatted.length<=this.maxChars)this.pageStart=0;
    let visible=words.slice(this.pageStart).join(' ');
    while(visible.length>this.maxChars && this.pageStart<words.length-1){
      let end=this.pageStart,length=0;
      while(end<words.length && length+words[end].length+(end>this.pageStart?1:0)<=this.maxChars){length+=words[end].length+(end>this.pageStart?1:0);end++;}
      // Whole pages advance once full, instead of sliding the first word on every update.
      this.pageStart=Math.max(this.pageStart+1,end);visible=words.slice(this.pageStart).join(' ');
    }
    visible=visible.slice(-this.maxChars);
    this.revision=revision;this.final=final;
    if(visible===this.text)return;
    this.text=visible;this.display({type:'english',en:visible,id,sequence,revision,final,startedClientAt});
  }
}
