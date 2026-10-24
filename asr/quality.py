"""Reject silence hallucinations and repeated decoder output, including fallbacks."""
import re

def reliable_text(text, seconds):
    words = re.findall(r"[\w']+", text.lower())
    if not words:
        return False
    if len(words) > seconds * 6 + 6:
        return False
    if re.search(r'\b(\w+)(?:\W+\1){7,}\b', text, re.IGNORECASE):
        return False
    if re.search(r'([a-z])\1{8,}', text, re.IGNORECASE):
        return False
    # Real audio produced long "iced tea" and "thank you" loops. Detect a
    # contiguous repeated phrase without rejecting ordinary brief stutters.
    for width in range(2,9):
        for start in range(len(words)-width*4+1):
            phrase=words[start:start+width]
            if all(words[start+width*repeat:start+width*(repeat+1)]==phrase for repeat in range(1,4)):
                return False
    for width in (3,4,5,6,7,8):
        grams = [tuple(words[i:i+width]) for i in range(len(words)-width+1)]
        if len(grams) >= width*3 and grams:
            counts = {gram:grams.count(gram) for gram in set(grams)}
            if max(counts.values()) >= 4 and len(set(grams))/len(grams) < .45:
                return False
    return True
