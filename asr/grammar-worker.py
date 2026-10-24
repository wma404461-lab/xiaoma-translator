"""Bounded pretrained CPU syntax checks. No transcripts are stored or trained on."""
import json,re,sys,time

def accepts_document(doc,text,previous=False):
    # Short requests can end on a transitive verb before its object arrives.
    # Keep this check local to short prefixes; relative-clause objects may occur
    # earlier in a longer sentence and must not be blocked indiscriminately.
    if len(text.split())<=5:
        last=next((token for token in reversed(list(doc)) if token.pos_!='PUNCT'),None)
        requires_object={'visit','visits','visited','buy','buys','bought','provide','provides','provided','use','uses','used','include','includes','included','bring','brings','brought','take','takes','took','make','makes','made','reach','reaches','reached','need','needs','needed','want','wants','wanted'}
        if last and last.pos_=='VERB' and last.lower_ in requires_object:
            has_object=any(child.dep_ in ('dobj','obj','iobj','ccomp','xcomp') for child in last.children)
            relative_gap=any(token.dep_=='relcl' for token in getattr(last,'ancestors',()))
            if not has_object and not relative_gap:return False
    roots=[token for token in doc if token.dep_=='ROOT']
    predicate=any(token.pos_ in ('VERB','AUX') or any(child.dep_=='cop' for child in token.children) for token in roots)
    relative=bool(previous) and any(token.lower_=='one' and any(child.dep_=='relcl' and child.pos_=='VERB' and any(subject.dep_ in ('nsubj','nsubjpass') for subject in child.children) for child in token.children) for token in roots)
    beginning=re.sub(r'^(?:(?:and|but|so)\s+)?(?:of course\s+)?','',text.lower().strip())
    nominal=bool(re.match(r'^(?:the|a|an|all|most|some|this|these|those|our|my|your|their)\b',beginning))
    return predicate or relative or not nominal

def main():
    import spacy
    nlp=spacy.load('en_core_web_sm',exclude=['ner','lemmatizer'])
    print(json.dumps({'type':'ready','model':nlp.meta['version']}),flush=True)
    for line in sys.stdin:
        value=None
        try:
            if len(line)>20000:raise ValueError('oversized')
            value=json.loads(line)
            if not isinstance(value,dict) or not isinstance(value.get('id'),int) or not isinstance(value.get('text'),str) or not 0<len(value['text'])<=4000:raise ValueError('invalid')
            began=time.perf_counter()
            with nlp.memory_zone():
                doc=nlp(value['text'].lower());allowed=accepts_document(doc,value['text'],value.get('previous',False))
            print(json.dumps({'id':value['id'],'allow':allowed,'reason':'incomplete-clause' if not allowed else 'allowed','parseMs':round((time.perf_counter()-began)*1000,3)}),flush=True)
        except Exception:
            print(json.dumps({'id':value.get('id') if isinstance(value,dict) else None,'error':'grammar-query-failed'}),flush=True)

if __name__=='__main__':main()
