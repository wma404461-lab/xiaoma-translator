"""Regressions for pathological output observed in real lecture audio."""
import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'asr'))
from quality import reliable_text

class SpeechQualityTest(unittest.TestCase):
    def test_empty_and_repeated_decoder_output_is_rejected(self):
        self.assertFalse(reliable_text('',6))
        self.assertFalse(reliable_text('A C T S S S S S S S S S S S S S',6))
        self.assertFalse(reliable_text('I just want to thank you. '*12,6))
        self.assertFalse(reliable_text('This is a short fragment. '*20,1))
        self.assertFalse(reliable_text('Here are two beautiful examples of your '+ 'iced tea '*10,6))
        self.assertFalse(reliable_text('Thank you '*5,6))

    def test_natural_repetition_negation_and_technical_speech_survive(self):
        self.assertTrue(reliable_text('I, I think this is not fifteen but fifty percent.',4))
        self.assertTrue(reliable_text('Coronal dimmings are signatures of coronal mass ejections.',4))
        self.assertTrue(reliable_text('No, no, no. That is not what I meant.',3))
        self.assertTrue(reliable_text('Thank you, thank you. We can begin now.',3))

if __name__=='__main__':unittest.main()
