import importlib.util,pathlib,unittest
path=pathlib.Path(__file__).resolve().parents[1]/'asr/grammar-worker.py'
spec=importlib.util.spec_from_file_location('grammar_worker',path);worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
class Token:
    def __init__(self,word,pos,dep,children=()):self.lower_=word;self.pos_=pos;self.dep_=dep;self.children=children
class GrammarPolicyTests(unittest.TestCase):
    def test_noun_root_and_relative_description_are_not_a_main_claim(self):
        relative=Token('made','VERB','relcl',(Token('who','PRON','nsubj'),))
        self.assertFalse(worker.accepts_document([Token('person','NOUN','ROOT',(relative,))],'The person who made our new report',True))
        self.assertFalse(worker.accepts_document([Token('work','NOUN','ROOT')],'AND OF COURSE ALL OF THIS WORK'))
    def test_copula_and_spoken_relative_keep_their_valid_meaning(self):
        self.assertTrue(worker.accepts_document([Token('tomorrow','NOUN','ROOT',(Token('is','AUX','cop'),))],'The deadline is tomorrow'))
        root=Token('one','NUM','ROOT',(Token('hope','VERB','relcl',(Token('we','PRON','nsubj'),)),))
        self.assertTrue(worker.accepts_document([root],'And one that we hope to preserve',True))
    def test_exclamations_and_greetings_are_not_blanket_blocked_as_nominal_fragments(self):
        self.assertTrue(worker.accepts_document([Token('place','NOUN','ROOT')],'What a wonderful place to watch the sunset'))
        self.assertTrue(worker.accepts_document([Token('evening','NOUN','ROOT')],'Good evening and welcome to the conference'))
    def test_short_bare_transitive_verbs_wait_for_their_object(self):
        self.assertFalse(worker.accepts_document([Token('want','VERB','ROOT'),Token('visit','VERB','xcomp')],'I want to visit'))
        self.assertTrue(worker.accepts_document([Token('visit','VERB','ROOT',(Token('Paris','PROPN','dobj'),)),Token('Paris','PROPN','dobj')],'I want to visit Paris'))
        self.assertTrue(worker.accepts_document([Token('start','VERB','ROOT'),Token('now','ADV','advmod')],'We can start now'))
if __name__=='__main__':unittest.main()
